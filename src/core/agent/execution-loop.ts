import { Logger } from 'pino';
import { IncomingMessage } from '../types';
import { LLMProvider, LLMRequest, LLMResult, ContinuationResult } from '../providers';
import { ToolResult, ToolRegistry } from '../tools';
import { AssembledAgentContext } from './context-assembler';

/**
 * Configuration options for the ReAct multi-hop execution loop.
 */
export interface ExecutionLoopOptions {
  llmProvider: LLMProvider;
  toolRegistry: ToolRegistry;
  logger?: Logger;
  enableMultiHop?: boolean;
  maxHops?: number;
  multiHopTools?: string[];
  fallbackModel?: string;
  enableSearchGrounding?: boolean;
}

/**
 * Result produced by running the multi-hop ReAct execution loop.
 */
export interface ExecutionLoopResult {
  text: string;
  sources?: { title: string; url: string }[];
  actionsExecuted: { toolName: string; result: any }[];
}

/**
 * Determines whether an error thrown by the LLM provider is a rate limit,
 * quota exhaustion, or transient server issue eligible for model failover.
 */
export function isFailoverEligibleError(error: unknown): boolean {
  if (!error) return false;
  const err = error as Record<string, any>;
  const status = err.status ?? err.code ?? err.statusCode;
  if (status === 429 || status === 503 || status === 500 || status === 502 || status === 504) {
    return true;
  }
  const message = typeof err.message === 'string' ? err.message : String(error);
  return /429|503|500|502|504|RESOURCE_EXHAUSTED|quota|rate\s*limit|unavailable|overloaded/i.test(message);
}

/**
 * Executes the multi-hop ReAct (Reason + Act) loop.
 * Coordinates initial LLM generation, parallel tool execution, signature deduplication,
 * and continuation dispatching across model hops until a final response is reached.
 */
export class ExecutionLoop {
  constructor(private options: ExecutionLoopOptions) {}

  /**
   * Runs the multi-hop ReAct execution loop using an assembled agent context.
   */
  async run(
    context: AssembledAgentContext,
    incoming: IncomingMessage
  ): Promise<ExecutionLoopResult> {
    const llmRequest: LLMRequest = {
      systemInstruction: context.systemInstruction,
      prompt: context.prompt,
      conversationHistory:
        context.conversationHistory.length > 0 ? context.conversationHistory : undefined,
      tools: context.tools.length > 0 ? context.tools : undefined,
      images:
        incoming.media?.type === 'image'
          ? [{ data: incoming.media.buffer, mimeType: incoming.media.mimeType }]
          : undefined,
      enableSearchGrounding: this.options.enableSearchGrounding,
    };

    return this.execute(llmRequest, incoming);
  }

  /**
   * Executes an arbitrary LLM request through the full ReAct multi-hop loop,
   * handling initial generation, parallel tool execution, signature deduplication,
   * and continuation dispatching across model hops.
   *
   * @param incoming - Standardized incoming message passed to tools for authorization context.
   */
  async execute(
    request: LLMRequest,
    incoming: IncomingMessage
  ): Promise<ExecutionLoopResult> {
    const enableMultiHop = this.options.enableMultiHop ?? true;
    const maxHops = enableMultiHop ? (this.options.maxHops ?? 4) : 1;
    const multiHopTools = new Set(this.options.multiHopTools ?? []);
    const primaryModel = this.options.llmProvider.modelName;
    const fallbackModel = this.options.fallbackModel;

    let activeModel = primaryModel;
    const actionsExecuted: { toolName: string; result: any }[] = [];

    // Phase 1: Initial LLM Generation Turn (with true failover)
    const initialExec = await this.executeWithFailover(
      activeModel,
      fallbackModel,
      '[ExecutionLoop] Initial generation',
      (modelName) =>
        this.options.llmProvider.generate({
          ...request,
          modelName,
        })
    );
    activeModel = initialExec.activeModel;
    const initialResult = initialExec.result;

    let currentResult: LLMResult = initialResult;
    let hopCount = 0;
    let sessionState: unknown = undefined;
    const executedCallSignatures = new Set<string>();

    // Phase 2: Multi-Hop ReAct Tool Resolution Loop
    while (
      currentResult.toolCalls &&
      currentResult.toolCalls.length > 0 &&
      hopCount < maxHops
    ) {
      const hopIndex = hopCount + 1;

      // Filter duplicate tool call signatures to prevent infinite execution loops
      const newCalls = currentResult.toolCalls.filter((call) => {
        const sig = `${call.name}:${JSON.stringify(call.args)}`;
        if (executedCallSignatures.has(sig)) {
          return false;
        }
        executedCallSignatures.add(sig);
        return true;
      });

      if (newCalls.length === 0) {
        this.options.logger?.warn(
          `[MultiHop] Duplicate tool call signature detected. Breaking out to prevent infinite loop.`
        );
        break;
      }

      // Execute authorized tools in parallel
      const executed = await this.options.toolRegistry.executeToolsParallel(
        newCalls,
        incoming
      );

      const toolResults: ToolResult[] = executed.map((item, idx) => {
        actionsExecuted.push({ toolName: item.toolName, result: item.result });
        return {
          toolCallId: newCalls[idx]?.id,
          toolName: item.toolName,
          result: item.result,
        };
      });

      const hasMultiHopEligibleTool = newCalls.some((call) => multiHopTools.has(call.name));

      if (!this.options.llmProvider.continueWithToolResults) {
        break;
      }

      try {
        const contExec = await this.executeWithFailover(
          activeModel,
          fallbackModel,
          `[MultiHop] Hop ${hopIndex}`,
          (modelName) =>
            this.options.llmProvider.continueWithToolResults!({
              originalRequest: request,
              toolCalls: newCalls,
              toolResults,
              modelName,
              sessionState,
            })
        );
        activeModel = contExec.activeModel;
        const continuation = contExec.result;

        currentResult = continuation;
        sessionState = continuation.sessionState;
        hopCount++;

        if (!currentResult.toolCalls || currentResult.toolCalls.length === 0) {
          break;
        }

        if (!hasMultiHopEligibleTool) {
          break;
        }
      } catch (error) {
        this.options.logger?.error(error, `[MultiHop] Hop ${hopIndex} failed`);
        // If the model already produced a valid text response in Turn 1, preserve it instead of failing fatally
        if (initialResult.text && initialResult.text.trim().length > 0) {
          currentResult = { ...currentResult, text: initialResult.text.trim() };
          break;
        }
        throw error;
      }
    }

    return {
      text: currentResult.text || initialResult.text || '',
      sources: currentResult.sources || initialResult.sources,
      actionsExecuted,
    };
  }

  /**
   * Generates an LLM response with automatic failover to the configured fallback model.
   */
  async generateWithFailover(request: LLMRequest): Promise<LLMResult> {
    const { result } = await this.executeWithFailover(
      this.options.llmProvider.modelName,
      this.options.fallbackModel,
      '[ExecutionLoop] Generation',
      (modelName) =>
        this.options.llmProvider.generate({
          ...request,
          modelName,
        })
    );
    return result;
  }

  /**
   * Executes an LLM operation with automatic failover to the configured fallback model
   * when a rate-limit or transient server error occurs.
   */
  private async executeWithFailover<T>(
    activeModel: string | undefined,
    fallbackModel: string | undefined,
    contextLabel: string,
    fn: (modelName: string | undefined) => Promise<T>
  ): Promise<{ result: T; activeModel: string | undefined }> {
    try {
      return { result: await fn(activeModel), activeModel };
    } catch (error) {
      if (fallbackModel && activeModel !== fallbackModel && isFailoverEligibleError(error)) {
        this.options.logger?.warn(
          error,
          `${contextLabel} failed on model "${activeModel}". Failing over to fallback model "${fallbackModel}".`
        );
        return { result: await fn(fallbackModel), activeModel: fallbackModel };
      }
      throw error;
    }
  }
}
