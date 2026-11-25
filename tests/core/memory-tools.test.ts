import { describe, it, expect, vi } from 'vitest';
import {
  createMemoryTools,
  createRememberFactTool,
  createRecallMemoryTool,
} from '../../src/core/tools/memory-tools';
import { MemoryService } from '../../src/core/memory/memory-service';
import { IncomingMessage } from '../../src/core/types';

describe('Memory Tools', () => {
  const mockMemoryService = {
    addCoreFact: vi.fn().mockResolvedValue(42),
    searchRelevantMemories: vi.fn().mockResolvedValue([
      { summary: 'Owner likes black coffee', score: 0.9 },
    ]),
  } as unknown as MemoryService;

  const tools = createMemoryTools(mockMemoryService);
  const rememberTool = tools.find((t) => t.name === 'remember_fact')!;
  const recallTool = tools.find((t) => t.name === 'recall_memory')!;

  it('exports individual factory functions alongside bundle', () => {
    const singleRemember = createRememberFactTool(mockMemoryService);
    const singleRecall = createRecallMemoryTool(mockMemoryService);

    expect(singleRemember.name).toBe('remember_fact');
    expect(singleRecall.name).toBe('recall_memory');
    expect(tools.length).toBe(2);
  });

  const createMsg = (role: 'owner' | 'guest'): IncomingMessage => ({
    id: '1',
    senderId: '123',
    senderName: 'Adli',
    chatId: '123',
    chatType: 'dm',
    role,
    text: 'test',
    timestamp: Date.now(),
  });

  it('remember_fact calls addCoreFact with role entity', async () => {
    const ownerMsg = createMsg('owner');
    const result = await rememberTool.execute(
      { category: 'preference', fact: 'Enjoys late-night coding' },
      ownerMsg
    );

    expect(mockMemoryService.addCoreFact).toHaveBeenCalledWith(
      'owner',
      'preference',
      'Enjoys late-night coding'
    );
    expect(result.status).toBe('success');
    expect(result.factId).toBe(42);
  });

  it('recall_memory searches episodic memories and returns matching list', async () => {
    const msg = createMsg('owner');
    const result = await recallTool.execute({ query: 'kopi' }, msg);

    expect(mockMemoryService.searchRelevantMemories).toHaveBeenCalledWith('kopi', '123', 3);
    expect(result.status).toBe('found');
    expect(result.memories).toEqual(['Owner likes black coffee']);
  });
});
