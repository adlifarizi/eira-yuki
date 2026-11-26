import { describe, it, expect, vi } from 'vitest';
import { PersonaBuilder } from '../../src/core/persona/persona-builder';
import { SemanticMoodEvaluator } from '../../src/core/persona/semantic-mood-evaluator';
import { LLMProvider, LLMRequest, LLMResult } from '../../src/core/providers/types';

describe('SemanticMoodEvaluator', () => {
  const defaultPersona = new PersonaBuilder('You are TestCompanion, a calm and observant AI.');

  const createMockProvider = (responseText: string): LLMProvider => ({
    id: 'mock-llm',
    name: 'Mock LLM',
    generate: vi.fn(async (_req: LLMRequest): Promise<LLMResult> => ({
      text: responseText,
    })),
  });

  it('evaluates emotional delta from structured LLM response using injected persona', async () => {
    const provider = createMockProvider('{"energy": 2, "composure": 1, "playfulness": 3, "affection": 4}');
    const evaluator = new SemanticMoodEvaluator(provider, defaultPersona);

    const delta = await evaluator.evaluate({
      userText: 'Kamu pinter banget deh, makasih ya!',
      assistantText: 'Sama-sama. Itu memang tugas saya.',
      senderRole: 'owner',
    });

    expect(delta).toEqual({
      energy: 2,
      composure: 1,
      playfulness: 3,
      affection: 4,
    });
    const req = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as LLMRequest;
    expect(req.prompt).toContain('COMPANION PERSONA:\nYou are TestCompanion, a calm and observant AI.');
  });

  it('enforces role firewall on guest affection even if LLM returns positive affection', async () => {
    const provider = createMockProvider('{"energy": 1, "composure": 0, "playfulness": 2, "affection": 5}');
    const evaluator = new SemanticMoodEvaluator(provider, defaultPersona);

    const delta = await evaluator.evaluate({
      userText: 'Hello, thank you for the help!',
      senderRole: 'guest',
    });

    expect(delta.affection).toBe(0);
    expect(delta.playfulness).toBe(2);
  });

  it('handles markdown json code block fences in LLM output', async () => {
    const provider = createMockProvider('```json\n{"energy": -1, "composure": -2, "playfulness": 0, "affection": 0}\n```');
    const evaluator = new SemanticMoodEvaluator(provider, defaultPersona);

    const delta = await evaluator.evaluate({
      userText: 'Stop talking nonsense!',
      senderRole: 'owner',
    });

    expect(delta.energy).toBe(-1);
    expect(delta.composure).toBe(-2);
  });

  it('recovers gracefully from malformed or empty output', async () => {
    const provider = createMockProvider('I am an AI and cannot rate this.');
    const evaluator = new SemanticMoodEvaluator(provider, defaultPersona);

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
    const evaluator = new SemanticMoodEvaluator(failingProvider, defaultPersona);

    const delta = await evaluator.evaluate({
      userText: 'Hello',
      senderRole: 'owner',
    });

    expect(delta).toEqual({});
  });

  it('includes recentHistory turns in the evaluation prompt when provided', async () => {
    const provider = createMockProvider('{"energy": 1, "composure": 1, "playfulness": 2, "affection": 1}');
    const evaluator = new SemanticMoodEvaluator(provider, defaultPersona);

    const delta = await evaluator.evaluate({
      userText: 'Haha iya juga ya',
      assistantText: 'Tentu saja.',
      senderRole: 'owner',
      recentHistory: [
        { role: 'user', content: 'hal apa yang kamu suka' },
        { role: 'assistant', content: 'Saya menyukai ketenangan.' },
        { role: 'user', content: 'kenapa begitu?' },
        { role: 'assistant', content: 'Karena efisiensi itu penting.' },
      ],
    });

    expect(delta).toEqual({ energy: 1, composure: 1, playfulness: 2, affection: 1 });
    const req = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as LLMRequest;
    expect(req.prompt).toContain('RECENT CONVERSATION:');
    expect(req.prompt).toContain('USER: "hal apa yang kamu suka"');
    expect(req.prompt).toContain('ASSISTANT: "Karena efisiensi itu penting."');
    expect(req.prompt).toContain('LATEST EXCHANGE:');
    expect(req.prompt).toContain('USER MESSAGE: "Haha iya juga ya"');
  });
});
