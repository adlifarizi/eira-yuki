import { describe, it, expect, vi } from 'vitest';
import { MemoryConsolidator } from '../../src/core/memory/memory-consolidator';
import { MemoryService } from '../../src/core/memory/memory-service';
import { LLMProvider } from '../../src/core/providers/types';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('MemoryConsolidator', () => {
  it('skips consolidation if message count is below threshold', async () => {
    const mockMemoryService = {
      getChatMessageCount: vi.fn().mockResolvedValue(2),
      getRecentChatHistory: vi.fn().mockResolvedValue([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hello as well' },
      ]),
      addEpisodicMemory: vi.fn(),
    } as unknown as MemoryService;

    const mockProvider: LLMProvider = {
      generate: vi.fn(),
    };

    const consolidator = new MemoryConsolidator(mockMemoryService, mockProvider, logger);
    const didRun = await consolidator.checkAndConsolidate('chat-1', 10);
    expect(didRun).toBe(false);
    expect(mockProvider.generate).not.toHaveBeenCalled();
  });

  it('triggers consolidation and saves episodic memory when threshold is reached', async () => {
    const fakeHistory = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i}`,
    }));

    const mockMemoryService = {
      getChatMessageCount: vi.fn().mockResolvedValue(12),
      getRecentChatHistory: vi.fn().mockResolvedValue(fakeHistory),
      addEpisodicMemory: vi.fn().mockResolvedValue(undefined),
    } as unknown as MemoryService;

    const mockProvider: LLMProvider = {
      generate: vi.fn().mockResolvedValue({
        text: 'The user and Eira discussed a new project topic.',
      }),
    };

    const consolidator = new MemoryConsolidator(mockMemoryService, mockProvider, logger);
    const didRun = await consolidator.checkAndConsolidate('chat-2', 10);

    expect(didRun).toBe(true);
    expect(mockProvider.generate).toHaveBeenCalled();
    expect(mockMemoryService.addEpisodicMemory).toHaveBeenCalledWith(
      'chat-2',
      'The user and Eira discussed a new project topic.',
      2
    );
  });
});
