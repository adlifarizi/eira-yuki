import { eq, and, desc, or, count } from 'drizzle-orm';
import { AppDatabase } from '../../database';
import { aiChatHistory, coreFacts, episodicMemories } from '../../database/schema';
import { cosineSimilarity } from './similarity';
import { Logger } from 'pino';
import { ChatMessage, ChatRole, EmbeddingProvider } from '../providers';

const MIN_MEMORY_SIMILARITY_SCORE = 0.15;
const DEFAULT_CHAT_HISTORY_LIMIT = 30;

function normalizeFactText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Builds an adapter-namespaced sender key (e.g. "whatsapp:628123") so guest facts
 * remain isolated across users and never collide across different messaging platforms.
 */
export function buildGuestSenderKey(senderId: string, adapter?: string): string {
  const trimmedId = senderId.trim();
  const trimmedAdapter = adapter?.trim();
  return trimmedAdapter ? `${trimmedAdapter}:${trimmedId}` : trimmedId;
}

/**
 * Service managing conversational memory, persistent core facts, and episodic memory search.
 */
export class MemoryService {
  constructor(
    private db: AppDatabase,
    private embeddingProvider: EmbeddingProvider,
    private logger?: Logger
  ) {}

  /**
   * Returns the total number of stored chat messages for a given chatId.
   */
  async getChatMessageCount(chatId: string): Promise<number> {
    if (!chatId) return 0;
    try {
      const rows = await this.db
        .select({ total: count() })
        .from(aiChatHistory)
        .where(eq(aiChatHistory.chatId, chatId));
      return Number(rows[0]?.total ?? 0);
    } catch (err) {
      this.logger?.error(err, 'Failed to count chat messages');
      return 0;
    }
  }

  /**
   * Save a single chat message (user or assistant) into short-term history.
   */
  async saveChatMessage(chatId: string, role: ChatRole, content: string): Promise<void> {
    if (!chatId || !content.trim()) return;

    try {
      await this.db.insert(aiChatHistory).values({
        chatId,
        role,
        content: content.trim(),
        timestamp: Date.now(),
      });
    } catch (err) {
      this.logger?.error(err, `Failed to save chat message for ${chatId}`);
    }
  }

  /**
   * Retrieve recent chat history in chronological order.
   */
  async getRecentChatHistory(
    chatId: string,
    limit: number = DEFAULT_CHAT_HISTORY_LIMIT
  ): Promise<ChatMessage[]> {
    if (!chatId) return [];

    try {
      const rows = await this.db
        .select()
        .from(aiChatHistory)
        .where(eq(aiChatHistory.chatId, chatId))
        .orderBy(desc(aiChatHistory.id))
        .limit(limit);

      return rows.reverse().map((r) => ({
        role: r.role as ChatRole,
        content: r.content,
      }));
    } catch (err) {
      this.logger?.error(err, `Failed to get chat history for ${chatId}`);
      return [];
    }
  }

  /**
   * Get the timestamp of the latest message for a chat.
   */
  async getLastMessageTimestamp(chatId: string): Promise<number | null> {
    if (!chatId) return null;
    try {
      const rows = await this.db
        .select({ timestamp: aiChatHistory.timestamp })
        .from(aiChatHistory)
        .where(eq(aiChatHistory.chatId, chatId))
        .orderBy(desc(aiChatHistory.id))
        .limit(1);

      return rows.length > 0 ? rows[0].timestamp : null;
    } catch (err) {
      this.logger?.error(err, `Failed to get last message timestamp for ${chatId}`);
      return null;
    }
  }

  /**
   * Store a persistent core fact about Owner, Eira, or a specific Guest.
   * Guest facts are scoped by `senderId` to prevent cross-guest bleed.
   * Deduplicates against existing facts for the same entity/scope using normalized text.
   */
  async addCoreFact(
    entity: 'owner' | 'eira' | 'guest',
    category: string,
    fact: string,
    senderId?: string
  ): Promise<number> {
    const trimmedFact = fact.trim();
    const scopedSenderId = entity === 'guest' ? (senderId?.trim() || null) : null;

    const existing = await this.getCoreFacts(entity, scopedSenderId ?? undefined);
    const normalizedNew = normalizeFactText(trimmedFact);
    const duplicate = existing.find((row) => normalizeFactText(row.fact) === normalizedNew);
    if (duplicate) {
      return duplicate.id;
    }

    const result = await this.db.insert(coreFacts).values({
      entity,
      senderId: scopedSenderId,
      category,
      fact: trimmedFact,
      timestamp: Date.now(),
    });

    return Number(result.lastInsertRowid) || 1;
  }

  /**
   * Get persistent core facts. For 'guest', `senderId` is required so facts
   * remain isolated per guest; returns an empty array if `senderId` is omitted.
   */
  async getCoreFacts(entity?: 'owner' | 'eira' | 'guest', senderId?: string) {
    if (entity === 'guest') {
      const trimmedSender = senderId?.trim();
      if (!trimmedSender) {
        return [];
      }
      return await this.db
        .select()
        .from(coreFacts)
        .where(and(eq(coreFacts.entity, 'guest'), eq(coreFacts.senderId, trimmedSender)));
    }
    if (entity) {
      return await this.db.select().from(coreFacts).where(eq(coreFacts.entity, entity));
    }
    return await this.db.select().from(coreFacts);
  }

  /**
   * Save an episodic memory (e.g. summary of a conversation or key event).
   */
  async addEpisodicMemory(chatId: string, summary: string, importance: number = 1): Promise<void> {
    let embedding: number[] = [];
    try {
      embedding = await this.embeddingProvider.getEmbedding(summary);
    } catch {
      // Embedding optional
    }

    await this.db.insert(episodicMemories).values({
      chatId,
      summary: summary.trim(),
      embedding: embedding.length > 0 ? JSON.stringify(embedding) : null,
      importance,
      timestamp: Date.now(),
    });
  }

  /**
   * Semantic search for relevant past memories using cosine similarity.
   */
  async searchRelevantMemories(
    query: string,
    chatId?: string,
    topK: number = 3
  ): Promise<{ summary: string; score: number }[]> {
    if (!query.trim()) return [];

    const episodes = chatId
      ? await this.db
          .select({
            summary: episodicMemories.summary,
            embedding: episodicMemories.embedding,
          })
          .from(episodicMemories)
          .where(or(eq(episodicMemories.chatId, chatId), eq(episodicMemories.chatId, 'global')))
      : await this.db
          .select({
            summary: episodicMemories.summary,
            embedding: episodicMemories.embedding,
          })
          .from(episodicMemories);

    if (episodes.length === 0) return [];

    let queryEmbedding: number[] = [];
    try {
      queryEmbedding = await this.embeddingProvider.getEmbedding(query);
    } catch (err) {
      this.logger?.warn({ err }, 'Embedding lookup failed; falling back to token overlap');
    }

    const scored = episodes.map((ep) => {
      let score: number;
      if (queryEmbedding.length > 0 && ep.embedding) {
        try {
          const parsedVec = JSON.parse(ep.embedding);
          score = cosineSimilarity(queryEmbedding, parsedVec);
        } catch {
          score = 0;
        }
      } else {
        // Fallback: simple token overlap
        const queryTokens = query.toLowerCase().split(/\s+/);
        const epTokens = ep.summary.toLowerCase().split(/\s+/);
        const matches = queryTokens.filter((t) => t.length > 2 && epTokens.includes(t));
        score = matches.length / Math.max(queryTokens.length, 1);
      }

      return { summary: ep.summary, score };
    });

    return scored
      .filter((item) => item.score > MIN_MEMORY_SIMILARITY_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Formats core facts and relevant episodic memories for injection into system instruction.
   */
  async buildMemoryContext(
    query: string,
    entity: 'owner' | 'guest',
    chatId?: string,
    senderId?: string
  ): Promise<string> {
    const sections: string[] = [];

    // 1. Core Profile Facts
    const facts = await this.getCoreFacts(entity, senderId);
    if (facts.length > 0) {
      const factLines = facts.map((f) => `- [${f.category}] ${f.fact}`);
      sections.push(`[CORE PROFILE FACTS ABOUT ${entity.toUpperCase()}]:\n${factLines.join('\n')}`);
    }

    // 2. Eira's personal lore/identity facts
    const eiraFacts = await this.getCoreFacts('eira');
    if (eiraFacts.length > 0) {
      const eiraLines = eiraFacts.map((f) => `- ${f.fact}`);
      sections.push(`[EIRA'S PERSONAL KNOWLEDGE & MEMORIES]:\n${eiraLines.join('\n')}`);
    }

    // 3. Relevant Past Memories
    const relevant = await this.searchRelevantMemories(query, chatId, 3);
    if (relevant.length > 0) {
      const memLines = relevant.map((r, i) => `${i + 1}. ${r.summary}`);
      sections.push(`[RELEVANT PAST CONVERSATIONS & EPISODIC MEMORIES]:\n${memLines.join('\n')}`);
    }

    return sections.join('\n\n');
  }
}
