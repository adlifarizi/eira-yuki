import { Logger } from 'pino';
import { LLMProvider } from '../providers';
import { InteractionContext, MoodDelta, MoodEvaluator } from './types';

export class SemanticMoodEvaluator implements MoodEvaluator {
  constructor(
    private llmProvider: LLMProvider,
    private logger?: Logger
  ) {}

  async evaluate(context: InteractionContext): Promise<MoodDelta> {
    const text = context.userText?.trim();
    if (!text) {
      return {};
    }

    const roleGuidance =
      context.senderRole === 'guest'
        ? 'Sender is a GUEST/STRANGER. You must set "affection": 0 to preserve Eira\'s emotional boundary with strangers.'
        : 'Sender is the PRIMARY OWNER/MASTER. Affection reflects trust, genuine appreciation, and emotional warmth towards Master.';

    const prompt = `Analyze the emotional and relational impact of this message exchange on Eira Yuki (an autonomous AI companion who is composed, loyal, and observant).

SENDER ROLE: ${context.senderRole.toUpperCase()}
USER MESSAGE: "${text}"
${context.assistantText ? `ASSISTANT RESPONSE: "${context.assistantText}"` : ''}

${roleGuidance}

SCORING GUIDELINES (Integer deltas from -5 to +5, where 0 means neutral/routine):
1. "energy":
   - Positive (+1 to +3): Engaging, inspiring, energizing interaction.
   - Negative (-1 to -3): Exhausting spam, tedious repetitive queries, or very long draining demands.
2. "composure":
   - Positive (+1 to +3): Respectful, calm, articulate, grounding interaction.
   - Negative (-1 to -4): Rude insults, chaotic spam, absurd trolling, erratic commands, or hostility.
3. "playfulness":
   - Positive (+1 to +4): Witty banter, shared laughter, teasing, jokes, memes.
   - Negative (-1 to -3): Extremely formal, somber, critical, strictly dry task-oriented discussion.
4. "affection":
   - For Master only: Positive (+1 to +4) on heartfelt gratitude, genuine warmth, thoughtful care. Negative (-1 to -3) on betrayal, contempt, or disrespect.
   - For Guest: MUST BE 0.

Evaluate any language, slang (Indonesian, English, Japanese, etc.), emoji, sarcasm, and subtext.

Output strictly valid JSON and nothing else:
{"energy": 0, "composure": 0, "playfulness": 0, "affection": 0}`;

    try {
      const result = await this.llmProvider.generate({
        systemInstruction:
          'You are an expert psychological sentiment and relational dynamics evaluator. Respond strictly with a JSON object.',
        prompt,
      });

      return this.parseDelta(result.text, context.senderRole);
    } catch (err) {
      this.logger?.debug({ err }, 'Failed to evaluate semantic mood');
      return {};
    }
  }

  private parseDelta(rawText: string, role: string): MoodDelta {
    if (!rawText) return {};

    try {
      const cleaned = rawText
        .replace(/```(?:json)?/gi, '')
        .replace(/```/g, '')
        .trim();

      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return {};

      const parsed = JSON.parse(jsonMatch[0]);
      const sanitize = (val: unknown): number => {
        if (typeof val !== 'number' || Number.isNaN(val)) return 0;
        return Math.max(-5, Math.min(5, Math.round(val)));
      };

      return {
        energy: sanitize(parsed.energy),
        composure: sanitize(parsed.composure),
        playfulness: sanitize(parsed.playfulness),
        affection: role === 'guest' ? 0 : sanitize(parsed.affection),
      };
    } catch (err) {
      this.logger?.debug({ err }, 'Failed to parse semantic mood JSON');
      return {};
    }
  }
}
