import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '../../src/database';
import { cosineSimilarity } from '../../src/core/memory/similarity';
import { MemoryService } from '../../src/core/memory/memory-service';
import { EmbeddingProvider } from '../../src/core/providers';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('Memory System', () => {
  describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
      const vec = [1, 2, 3];
      expect(cosineSimilarity(vec, vec)).toBeCloseTo(1);
    });

    it('returns 0 for orthogonal vectors', () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    });

    it('returns 0 for empty vectors', () => {
      expect(cosineSimilarity([], [])).toBe(0);
    });
  });

  describe('MemoryService with Database Operations', () => {
    let memoryService: MemoryService;
    let mockEmbeddingProvider: EmbeddingProvider;

    beforeEach(() => {
      mockEmbeddingProvider = {
        id: 'mock-embedding',
        name: 'Mock Embedding',
        getEmbedding: vi.fn().mockImplementation(async (text: string) => {
          if (text.includes('coffee')) return [1, 0, 0];
          if (text.includes('game')) return [0, 1, 0];
          return [0.5, 0.5, 0];
        }),
      };

      memoryService = new MemoryService(db, mockEmbeddingProvider, logger);
    });

    it('saves chat messages and retrieves them in chronological order', async () => {
      const testChatId = `test-${Date.now()}@s.whatsapp.net`;
      await memoryService.saveChatMessage(testChatId, 'user', 'Hello Eira');
      await memoryService.saveChatMessage(testChatId, 'assistant', 'Hello as well!');

      const history = await memoryService.getRecentChatHistory(testChatId, 5);
      expect(history.length).toBe(2);
      expect(history[0]).toEqual({ role: 'user', content: 'Hello Eira' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'Hello as well!' });
    });

    it('adds and retrieves core facts', async () => {
      const factId = await memoryService.addCoreFact(
        'owner',
        'preference',
        'Loves black coffee without sugar'
      );
      expect(factId).toBeGreaterThan(0);

      const facts = await memoryService.getCoreFacts('owner');
      const found = facts.find((f) => f.fact.includes('black coffee'));
      expect(found).toBeDefined();
      expect(found?.category).toBe('preference');
    });

    it('adds episodic memory and searches via vector similarity', async () => {
      const testChatId = `session-${Date.now()}`;
      await memoryService.addEpisodicMemory(testChatId, 'Owner mentioned that he really loves coffee');
      await memoryService.addEpisodicMemory(testChatId, 'Owner played RPG games until late night');

      const results = await memoryService.searchRelevantMemories('coffee', testChatId, 2);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].summary).toContain('coffee');
      expect(results[0].score).toBeGreaterThan(0.5);
    });

    it('filters episodic memories by chatId and includes global memories at SQL level', async () => {
      const chatA = `chat-A-${Date.now()}`;
      const chatB = `chat-B-${Date.now()}`;

      await memoryService.addEpisodicMemory(chatA, 'Chat A secret coffee project');
      await memoryService.addEpisodicMemory(chatB, 'Chat B private coffee meeting');
      await memoryService.addEpisodicMemory('global', 'Global coffee facts');

      const resultsA = await memoryService.searchRelevantMemories('coffee', chatA, 10);
      const summariesA = resultsA.map((r) => r.summary);

      expect(summariesA).toContain('Chat A secret coffee project');
      expect(summariesA).toContain('Global coffee facts');
      expect(summariesA).not.toContain('Chat B private coffee meeting');
    });

    it('builds combined memory context for system instruction', async () => {
      const context = await memoryService.buildMemoryContext('coffee', 'owner');
      expect(context).toContain('[CORE PROFILE FACTS ABOUT OWNER]');
      expect(context).toContain('black coffee');
    });
  });
});
