import { Logger } from 'pino';
import { DecisionProvider } from '../providers/types';

export interface EvaluateActionOmissionParams {
  userPrompt: string;
  agentResponse: string;
  availableTools: { name: string; description: string }[];
}

export interface ActionOmissionEvaluatorOptions {
  decisionProvider: DecisionProvider;
  threshold: number;
  logger?: Logger;
}

/**
 * High-speed action omission evaluator that analyzes whether an agent made an action commitment
 * without executing a required tool call, consuming an injected DecisionProvider.
 */
export class ActionOmissionEvaluator {
  constructor(private options: ActionOmissionEvaluatorOptions) {}

  /**
   * Evaluates if the agent response indicates an operational action was omitted.
   * Compares the decision score probability against the configured threshold.
   */
  async isActionOmitted(params: EvaluateActionOmissionParams): Promise<boolean> {
    if (
      !params.availableTools ||
      params.availableTools.length === 0 ||
      !params.agentResponse?.trim()
    ) {
      return false;
    }

    try {
      const toolSummaries = params.availableTools
        .map((t) => `- ${t.name}: ${t.description}`)
        .join('\n');

      const input = `Available Tools:
${toolSummaries}

User Request: "${params.userPrompt}"
Agent Response: "${params.agentResponse}"`;

      const instructions =
        'Did the user request an operational action or did the agent promise/claim to perform or schedule an action requiring one of the Available Tools, yet NO tool was executed in this turn?';

      const score = await this.options.decisionProvider.evaluateDecision(input, instructions);
      if (!score) {
        return false;
      }

      const isOmitted = score.probability >= this.options.threshold;
      this.options.logger?.debug(
        `[ActionOmissionEvaluator] Decision probability: ${score.probability} (threshold: ${this.options.threshold}, confidence: ${score.confidence}) -> isOmitted: ${isOmitted}`
      );
      return isOmitted;
    } catch (error) {
      this.options.logger?.warn(error, '[ActionOmissionEvaluator] Action omission evaluation failed');
      return false;
    }
  }
}
