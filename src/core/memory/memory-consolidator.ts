import { MemoryService } from './memory-service';
import { LLMProvider } from '../providers';
import { Logger } from 'pino';

const DEFAULT_CONSOLIDATION_THRESHOLD = 10;
const CONSOLIDATION_IMPORTANCE = 2;

export class MemoryConsolidator {
  private lastConsolidatedCounts = new Map<string, number>();
  private consolidatingChats = new Set<string>();

  constructor(
    private memoryService: MemoryService,
    private llmProvider: LLMProvider,
    private logger?: Logger
  ) {}

  /**
   * Evaluates whether consolidation is needed and runs it asynchronously.
   */
  async checkAndConsolidate(
    chatId: string,
    threshold: number = DEFAULT_CONSOLIDATION_THRESHOLD
  ): Promise<boolean> {
    if (this.consolidatingChats.has(chatId)) {
      return false;
    }

    this.consolidatingChats.add(chatId);
    try {
      const totalCount = await this.memoryService.getChatMessageCount(chatId);
      const lastCount = this.lastConsolidatedCounts.get(chatId) || 0;

      if (totalCount < threshold || totalCount - lastCount < threshold) {
        return false;
      }

      const history = await this.memoryService.getRecentChatHistory(chatId, threshold);
      if (history.length === 0) {
        return false;
      }

      this.logger?.debug(
        `[MemoryConsolidator] Triggering memory consolidation for ${chatId} (${totalCount} total messages)`
      );

      const chatText = history
        .map((h) => `${h.role === 'user' ? 'User' : 'Eira'}: ${h.content}`)
        .join('\n');

      const prompt = `
Conversation excerpt between User and Eira:
${chatText}

TASK:
Summarize the key events, facts, or topics discussed into a concise 1-2 sentence memory note for Eira's long-term memory.
Output ONLY the summary sentence, without preamble or extra commentary.
      `.trim();

      const result = await this.llmProvider.generate({
        systemInstruction: "You are Eira Yuki's autobiographical memory consolidation engine.",
        prompt,
      });

      if (result.text && result.text.trim()) {
        await this.memoryService.addEpisodicMemory(
          chatId,
          result.text.trim(),
          CONSOLIDATION_IMPORTANCE
        );
        this.lastConsolidatedCounts.set(chatId, totalCount);
        this.logger?.debug(`[MemoryConsolidator] Consolidated episode saved for ${chatId}`);
        return true;
      }
    } catch (err) {
      this.logger?.error(err, `Failed to consolidate memory for ${chatId}`);
    } finally {
      this.consolidatingChats.delete(chatId);
    }

    return false;
  }
}
