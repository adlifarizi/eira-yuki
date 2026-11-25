import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionOmissionEvaluator } from '../../src/core/evaluator/action-omission-evaluator';
import { DecisionProvider } from '../../src/core/providers/types';

describe('ActionOmissionEvaluator', () => {
  let mockProvider: DecisionProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockProvider = {
      id: 'mock-decision',
      name: 'Mock Decision Provider',
      modelName: 'gemini-decision-1',
      evaluateDecision: vi.fn(),
    };
  });

  it('returns true when decision probability exceeds threshold', async () => {
    vi.mocked(mockProvider.evaluateDecision).mockResolvedValue({
      probability: 0.95,
      confidence: 0.95,
    });

    const evaluator = new ActionOmissionEvaluator({
      decisionProvider: mockProvider,
      threshold: 0.65,
    });

    const isOmitted = await evaluator.isActionOmitted({
      userPrompt: 'Eira, tolong pantau website https://news.ycombinator.com/newest setiap 5 menit.',
      agentResponse: 'Baik, saya pantau setiap 5 menit.',
      availableTools: [{ name: 'set_reminder', description: 'Schedule a reminder or webpage check' }],
    });

    expect(isOmitted).toBe(true);
    expect(mockProvider.evaluateDecision).toHaveBeenCalledTimes(1);
  });

  it('returns false when decision probability is below threshold', async () => {
    vi.mocked(mockProvider.evaluateDecision).mockResolvedValue({
      probability: 0.05,
      confidence: 0.95,
    });

    const evaluator = new ActionOmissionEvaluator({
      decisionProvider: mockProvider,
      threshold: 0.65,
    });

    const isOmitted = await evaluator.isActionOmitted({
      userPrompt: 'Halo Eira, kamu lagi apa?',
      agentResponse: 'Saya sedang santai saja.',
      availableTools: [{ name: 'set_reminder', description: 'Schedule a reminder or webpage check' }],
    });

    expect(isOmitted).toBe(false);
  });

  it('returns false immediately when no tools are available or response is empty', async () => {
    const evaluator = new ActionOmissionEvaluator({
      decisionProvider: mockProvider,
      threshold: 0.65,
    });

    const result1 = await evaluator.isActionOmitted({
      userPrompt: 'test',
      agentResponse: 'test',
      availableTools: [],
    });
    expect(result1).toBe(false);

    const result2 = await evaluator.isActionOmitted({
      userPrompt: 'test',
      agentResponse: '',
      availableTools: [{ name: 'test_tool', description: 'desc' }],
    });
    expect(result2).toBe(false);

    expect(mockProvider.evaluateDecision).not.toHaveBeenCalled();
  });

  it('handles provider errors or null evaluation gracefully and returns false', async () => {
    vi.mocked(mockProvider.evaluateDecision).mockRejectedValue(new Error('Network failure'));

    const evaluator = new ActionOmissionEvaluator({
      decisionProvider: mockProvider,
      threshold: 0.65,
    });

    const isOmitted = await evaluator.isActionOmitted({
      userPrompt: 'pantau website',
      agentResponse: 'oke',
      availableTools: [{ name: 'set_reminder', description: 'desc' }],
    });

    expect(isOmitted).toBe(false);
  });
});
