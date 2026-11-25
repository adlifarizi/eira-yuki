import { describe, it, expect, vi } from 'vitest';
import { SemanticMoodEvaluator } from '../../src/core/persona/semantic-mood-evaluator';
import { LLMProvider, LLMRequest, LLMResult } from '../../src/core/providers/types';

describe('SemanticMoodEvaluator', () => {
  const createMockProvider = (responseText: string): LLMProvider => ({
    id: 'mock-llm',
    name: 'Mock LLM',
    generate: vi.fn(async (_req: LLMRequest): Promise<LLMResult> => ({
      text: responseText,
    })),
  });

  it('evaluates emotional delta from structured LLM response', async () => {
    const provider = createMockProvider('{"energy": 2, "composure": 1, "playfulness": 3, "affection": 4}');
    const evaluator = new SemanticMoodEvaluator(provider);

    const delta = await evaluator.evaluate({
      userText: 'Eira kamu pinter banget deh, makasih ya!',
      assistantText: 'Sama-sama. Itu memang tugas saya.',
      senderRole: 'owner',
    });

    expect(delta).toEqual({
      energy: 2,
      composure: 1,
      playfulness: 3,
      affection: 4,
    });
  });

  it('enforces role firewall on guest affection even if LLM returns positive affection', async () => {
    const provider = createMockProvider('{"energy": 1, "composure": 0, "playfulness": 2, "affection": 5}');
    const evaluator = new SemanticMoodEvaluator(provider);

    const delta = await evaluator.evaluate({
      userText: 'Hello Eira, thank you for the help!',
      senderRole: 'guest',
    });

    expect(delta.affection).toBe(0);
    expect(delta.playfulness).toBe(2);
  });

  it('handles markdown json code block fences in LLM output', async () => {
    const provider = createMockProvider('```json\n{"energy": -1, "composure": -2, "playfulness": 0, "affection": 0}\n```');
    const evaluator = new SemanticMoodEvaluator(provider);

    const delta = await evaluator.evaluate({
      userText: 'Stop talking nonsense!',
      senderRole: 'owner',
    });

    expect(delta.energy).toBe(-1);
    expect(delta.composure).toBe(-2);
  });

  it('recovers gracefully from malformed or empty output', async () => {
    const provider = createMockProvider('I am an AI and cannot rate this.');
    const evaluator = new SemanticMoodEvaluator(provider);

    const delta = await evaluator.evaluate({
      userText: 'Some random text',
      senderRole: 'owner',
    });

    expect(delta).toEqual({});
  });

  it('recovers gracefully when LLM provider throws an error', async () => {
    const failingProvider: LLMProvider = {
      id: 'failing-llm',
      name: 'Failing LLM',
      generate: vi.fn(async () => {
        throw new Error('API Rate Limited');
      }),
    };
    const evaluator = new SemanticMoodEvaluator(failingProvider);

    const delta = await evaluator.evaluate({
      userText: 'Hello',
      senderRole: 'owner',
    });

    expect(delta).toEqual({});
  });
});
