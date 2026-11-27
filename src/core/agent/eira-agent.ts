import { Logger } from 'pino';
import { IncomingMessage, CoreResponse, ResponseAttachment, StickerResolver } from '../types';
import { ChatMessage } from '../providers';
import { MoodService, MoodEvaluator } from '../persona';
import { MemoryService, MemoryConsolidator } from '../memory';
import { ContextAssembler, AssembledAgentContext, DEFAULT_MAX_HISTORY_LIMIT, formatGroupTurnContent } from './context-assembler';
import { ExecutionLoop, ExecutionLoopResult } from './execution-loop';
import { ReflexionGuard } from './reflexion-guard';
import { isStickerToolResult, SEND_STICKER_TOOL_NAME } from '../tools/sticker-tool';

export const DEFAULT_MOOD_EVALUATION_INTERVAL = 5;

/**
 * Configuration options and dependencies injected into EiraAgent.
 */
export interface EiraAgentOptions {
  contextAssembler: ContextAssembler;
  executionLoop: ExecutionLoop;
  reflexionGuard: ReflexionGuard;
  logger?: Logger;
  memoryService?: MemoryService;
  memoryConsolidator?: MemoryConsolidator;
  moodService?: MoodService;
  moodEvaluator?: MoodEvaluator;
  /** Number of turns between background semantic mood evaluations (0 disables evaluation). */
  moodEvaluationInterval?: number;
  stickerCatalog?: StickerResolver;
  consolidationThreshold?: number;
  maxHistoryLimit?: number;
}

/**
 * Core conversational intelligence agent.
 * Orchestrates context assembly, multi-hop reasoning loop, reflexion verification,
 * and memory persistence for incoming messages.
 */
export class EiraAgent {
  private contextAssembler: ContextAssembler;
  private executionLoop: ExecutionLoop;
  private reflexionGuard: ReflexionGuard;
  private moodTurnCounters = new Map<string, number>();

  constructor(private options: EiraAgentOptions) {
    this.contextAssembler = options.contextAssembler;
    this.executionLoop = options.executionLoop;
    this.reflexionGuard = options.reflexionGuard;
  }

  /**
   * Main entry point for processing incoming chat messages.
   *
   * Executes the conversational agent pipeline:
   * 1. Context assembly (persona, reminders, mood, memory facts, chat history).
   * 2. Multi-hop ReAct execution loop (LLM generation and parallel tool execution).
   * 3. Reflexion guard verification (detecting and executing any missed commitments).
   * 4. Response synthesis (ensures natural confirmation if tools ran with empty model text).
   * 5. Persistence and asynchronous memory consolidation.
   * 6. Rich Media & Attachment Resolution
   */
  async handleMessage(incoming: IncomingMessage): Promise<CoreResponse> {
    const context = await this.contextAssembler.assemble(incoming);
    const loopResult = await this.executionLoop.run(context, incoming);
    const guardedResult = await this.reflexionGuard.evaluate(incoming, context, loopResult);
    const finalResult = await this.synthesizeIfEmpty(context, guardedResult);
    await this.persistAndConsolidate(incoming, finalResult.text, context.conversationHistory);
    const attachment = this.resolveAttachment(finalResult);

    return {
      text: finalResult.text,
      sources: finalResult.sources,
      attachment,
      actionsExecuted:
        finalResult.actionsExecuted.length > 0 ? finalResult.actionsExecuted : undefined,
    };
  }

  private async synthesizeIfEmpty(
    context: AssembledAgentContext,
    result: ExecutionLoopResult
  ): Promise<ExecutionLoopResult> {
    if (result.text?.trim() || result.actionsExecuted.length === 0) {
      return result;
    }

    try {
      const synth = await this.executionLoop.generateWithFailover({
        systemInstruction: context.systemInstruction,
        prompt: `[SYSTEM]: The requested action(s) have finished executing: ${JSON.stringify(
          result.actionsExecuted.map((a) => ({ tool: a.toolName, result: a.result }))
        )}. Provide a brief, natural confirmation for the user in your established persona.`,
      });

      return {
        ...result,
        text: synth.text?.trim() || 'Action completed successfully.',
      };
    } catch (err) {
      this.options.logger?.debug({ err }, 'Response synthesis fallback failed');
      return {
        ...result,
        text: 'Action completed successfully.',
      };
    }
  }

  private async persistAndConsolidate(
    incoming: IncomingMessage,
    text: string,
    conversationHistory: ChatMessage[]
  ): Promise<void> {
    if (!this.options.memoryService || !text?.trim()) return;

    try {
      const mediaLabel = incoming.media
        ? `[${incoming.media.type.charAt(0).toUpperCase() + incoming.media.type.slice(1)}]`
        : '';
      const userContent = incoming.text?.trim() || mediaLabel;
      if (userContent) {
        const persistedUserContent = formatGroupTurnContent(incoming, userContent);
        await this.options.memoryService.saveChatMessage(
          incoming.chatId,
          'user',
          persistedUserContent
        );
        await this.options.memoryService.saveChatMessage(incoming.chatId, 'assistant', text.trim());
      }

      if (this.options.memoryConsolidator) {
        const threshold =
          this.options.consolidationThreshold ??
          Math.floor((this.options.maxHistoryLimit ?? DEFAULT_MAX_HISTORY_LIMIT) / 2);

        this.options.memoryConsolidator
          .checkAndConsolidate(incoming.chatId, threshold)
          .catch((err) => {
            this.options.logger?.warn({ err }, 'Asynchronous memory consolidation failed');
          });
      }

      if (userContent) {
        this.scheduleMoodEvaluation(incoming, userContent, text.trim(), conversationHistory);
      }
    } catch (err) {
      this.options.logger?.warn({ err }, 'Failed to persist or consolidate conversation turn');
    }
  }

  /**
   * Throttles background mood evaluation to run once every N turns per chat,
   * passing the skipped turns from conversationHistory so mood reflects the full window.
   */
  private scheduleMoodEvaluation(
    incoming: IncomingMessage,
    userContent: string,
    assistantText: string,
    conversationHistory: ChatMessage[]
  ): void {
    if (!this.options.moodEvaluator || !this.options.moodService) return;

    const interval = this.options.moodEvaluationInterval ?? DEFAULT_MOOD_EVALUATION_INTERVAL;
    if (interval <= 0) return;

    const nextCount = (this.moodTurnCounters.get(incoming.chatId) ?? 0) + 1;
    if (nextCount < interval) {
      this.moodTurnCounters.set(incoming.chatId, nextCount);
      return;
    }

    this.moodTurnCounters.set(incoming.chatId, 0);

    const priorMessageCount = (interval - 1) * 2;
    const recentHistory =
      priorMessageCount > 0 && conversationHistory.length > 0
        ? conversationHistory.slice(-priorMessageCount)
        : undefined;

    this.options.moodEvaluator
      .evaluate({
        userText: userContent,
        assistantText,
        senderRole: incoming.role,
        recentHistory,
      })
      .then((delta) => this.options.moodService?.applyDelta(delta, incoming.role))
      .catch((err) => {
        this.options.logger?.debug({ err }, 'Asynchronous mood update failed');
      });
  }

  /**
   * Resolves rich media attachments (such as reaction stickers) triggered during tool execution.
   * Isolates media resolution inside the core layer so adapters receive ready-to-dispatch payloads.
   */
  private resolveAttachment(result: ExecutionLoopResult): ResponseAttachment | undefined {
    const stickerAction = result.actionsExecuted.find(
      (a) => a.toolName === SEND_STICKER_TOOL_NAME && isStickerToolResult(a.result)
    );

    if (stickerAction && isStickerToolResult(stickerAction.result) && this.options.stickerCatalog) {
      const tagOrId = stickerAction.result.stickerRequested;
      const buffer = this.options.stickerCatalog.getSticker(tagOrId);

      if (buffer) {
        return {
          type: 'sticker',
          payload: buffer,
          metadata: {
            id: tagOrId,
            reason: stickerAction.result.reason,
          },
        };
      }
    }

    return undefined;
  }
}
