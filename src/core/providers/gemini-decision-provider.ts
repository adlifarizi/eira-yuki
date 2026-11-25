import { GoogleGenAI } from '@google/genai';
import { Logger } from 'pino';
import { DecisionProvider, DecisionScore } from './types';

export interface GeminiDecisionProviderOptions {
  apiKey: string;
  modelName: string;
  logger?: Logger;
}

/**
 * Gemini Decisions API adapter implementing the DecisionProvider interface.
 * Uses high-speed, zero-output-token probabilistic evaluations (type: 'noul').
 */
export class GeminiDecisionProvider implements DecisionProvider {
  readonly id = 'gemini-decision';
  readonly name = 'Gemini Decision Provider';
  readonly modelName: string;

  private client: GoogleGenAI;
  private logger?: Logger;

  constructor(options: GeminiDecisionProviderOptions) {
    this.client = new GoogleGenAI({ apiKey: options.apiKey, apiVersion: 'v1beta' });
    this.modelName = options.modelName;
    this.logger = options.logger;
  }

  /**
   * Evaluates a binary or probabilistic decision given an input context and instructions.
   */
  async evaluateDecision(input: string, instructions: string): Promise<DecisionScore | null> {
    try {
      const result = await this.client.decisions.create({
        model: this.modelName,
        input,
        questions: {
          decision: {
            type: 'noul',
            instructions,
          },
        },
      });

      const answer = (result.answers as any)?.decision;
      if (answer && answer.type === 'noul' && typeof answer.noul === 'number') {
        this.logger?.debug(
          `[GeminiDecisionProvider] Evaluation result: noul=${answer.noul}, confidence=${answer.confidence}`
        );
        return {
          probability: answer.noul,
          confidence: answer.confidence,
        };
      }

      return null;
    } catch (error) {
      this.logger?.warn(error, '[GeminiDecisionProvider] Decision evaluation failed');
      return null;
    }
  }
}
