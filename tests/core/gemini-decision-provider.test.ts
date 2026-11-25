import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiDecisionProvider } from '../../src/core/providers/gemini-decision-provider';

describe('GeminiDecisionProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes with explicit modelName', () => {
    const provider = new GeminiDecisionProvider({
      apiKey: 'test-key',
      modelName: 'custom-decision-model',
    });
    expect(provider.modelName).toBe('custom-decision-model');
    expect(provider.id).toBe('gemini-decision');
  });

  it('evaluates decision and returns probability and confidence on valid noul response', async () => {
    const provider = new GeminiDecisionProvider({
      apiKey: 'test-key',
      modelName: 'gemini-decision-1',
    });

    (provider as any).client = {
      decisions: {
        create: vi.fn().mockResolvedValue({
          answers: {
            decision: {
              type: 'noul',
              noul: 0.85,
              confidence: 0.9,
            },
          },
        }),
      },
    };

    const result = await provider.evaluateDecision('test input', 'test instruction');

    expect(result).toEqual({
      probability: 0.85,
      confidence: 0.9,
    });
    expect((provider as any).client.decisions.create).toHaveBeenCalledWith({
      model: 'gemini-decision-1',
      input: 'test input',
      questions: {
        decision: {
          type: 'noul',
          instructions: 'test instruction',
        },
      },
    });
  });

  it('returns null when answer is missing or not of type noul', async () => {
    const provider = new GeminiDecisionProvider({
      apiKey: 'test-key',
      modelName: 'gemini-decision-1',
    });

    (provider as any).client = {
      decisions: {
        create: vi.fn().mockResolvedValue({
          answers: {},
        }),
      },
    };

    const result = await provider.evaluateDecision('test input', 'test instruction');
    expect(result).toBeNull();
  });

  it('handles client errors gracefully and returns null without throwing', async () => {
    const provider = new GeminiDecisionProvider({
      apiKey: 'test-key',
      modelName: 'gemini-decision-1',
    });

    (provider as any).client = {
      decisions: {
        create: vi.fn().mockRejectedValue(new Error('API quota exceeded')),
      },
    };

    const result = await provider.evaluateDecision('test input', 'test instruction');
    expect(result).toBeNull();
  });
});
