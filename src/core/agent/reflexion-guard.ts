import { Logger } from 'pino';
import { IncomingMessage } from '../types';
import { LLMRequest } from '../providers';
import { ActionOmissionEvaluator } from '../evaluator';
import { AssembledAgentContext } from './context-assembler';
import { ExecutionLoop, ExecutionLoopResult } from './execution-loop';

/**
 * Options and dependencies for ReflexionGuard.
 */
export interface ReflexionGuardOptions {
  executionLoop: ExecutionLoop;
  actionEvaluator?: ActionOmissionEvaluator;
  logger?: Logger;
}

/**
 * Guards against unexecuted operational commitments by evaluating owner responses
 * and triggering a corrective execution pass when required actions were omitted.
 */
export class ReflexionGuard {
  constructor(private options: ReflexionGuardOptions) {}

  /**
   * Evaluates whether the model promised an action without invoking any tool,
   * and triggers a corrective execution pass if an omission is detected.
   */
  async evaluate(
    incoming: IncomingMessage,
    context: AssembledAgentContext,
    currentResult: ExecutionLoopResult
  ): Promise<ExecutionLoopResult> {
    // Pre-condition: Enforce action execution exclusively on owner turns where tools were available but omitted
    if (
      incoming.role !== 'owner' ||
      currentResult.actionsExecuted.length > 0 ||
      context.tools.length === 0 ||
      !currentResult.text
    ) {
      return currentResult;
    }

    const isOmitted = await this.detectActionOmission(
      incoming.text || '',
      currentResult.text,
      context.tools
    );

    if (!isOmitted) {
      return currentResult;
    }

    this.options.logger?.warn(
      `[ReflexionGuard] Action omission detected without tool execution for user: "${incoming.text}". Prompting model for tool invocation.`
    );

    // Frame reflection history showing the unfulfilled conversational commitment
    const reflectionHistory = [
      ...(context.conversationHistory || []),
      { role: 'user' as const, content: incoming.text || '' },
      { role: 'assistant' as const, content: currentResult.text },
    ];

    const correctionRequest: LLMRequest = {
      systemInstruction: context.systemInstruction,
      prompt: `[SYSTEM ACTION GUARD]: You claimed or promised an operational action (such as scheduling, monitoring, cancelling, or saving), but you did NOT invoke any function tool. Plain text CANNOT modify databases or schedule tasks. You MUST invoke the appropriate function call now to execute this request, or clarify if no action is needed.`,
      conversationHistory: reflectionHistory,
      tools: context.tools,
    };

    try {
      const correctionResult = await this.options.executionLoop.execute(correctionRequest, incoming);

      // If the correction turn successfully produced tool actions, return the recovered turn result
      if (correctionResult.actionsExecuted.length > 0) {
        return {
          text: correctionResult.text || currentResult.text,
          sources: correctionResult.sources || currentResult.sources,
          actionsExecuted: [
            ...currentResult.actionsExecuted,
            ...correctionResult.actionsExecuted,
          ],
        };
      }
    } catch (err) {
      this.options.logger?.error(err, '[ReflexionGuard] Reflexion turn failed');
    }

    return currentResult;
  }

  private async detectActionOmission(
    userText: string,
    modelText: string,
    availableTools: { name: string; description: string }[]
  ): Promise<boolean> {
    if (this.options.actionEvaluator) {
      return this.options.actionEvaluator.isActionOmitted({
        userPrompt: userText,
        agentResponse: modelText,
        availableTools,
      });
    }

    return false;
  }
}
