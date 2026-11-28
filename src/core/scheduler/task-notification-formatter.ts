import { LLMProvider } from '../providers';
import { PersonaBuilder } from '../persona';
import { TaskDispatchEvent } from './types';
import { MAX_WATCH_CONTENT_CHARS } from './constants';

const NO_RELEVANT_CHANGE_MARKER = 'NO_RELEVANT_CHANGE';

const EMOJI_REGEX =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;

/**
 * Formats proactive notifications dispatched by scheduled background tasks.
 * Converts task dispatch events into natural companion messages adhering to persona guidelines.
 */
export class TaskNotificationFormatter {
  constructor(
    private llmProvider: LLMProvider,
    private personaBuilder: PersonaBuilder
  ) {}

  /**
   * Formats a scheduled task dispatch event into a natural conversational notification.
   * Returns `null` when a `watch_url` hash change is evaluated as irrelevant noise.
   */
  async format(event: TaskDispatchEvent, recipientName: string = 'User'): Promise<string | null> {
    if (event.actionType === 'watch_url') {
      return this.synthesizeWebUpdateAlert(event, recipientName);
    }
    return this.synthesizeReminderAlert(event, recipientName);
  }

  private async synthesizeReminderAlert(
    event: TaskDispatchEvent,
    recipientName: string
  ): Promise<string> {
    const baseInstruction = this.personaBuilder.getBaseInstruction();

    try {
      const result = await this.llmProvider.generate({
        systemInstruction: `${baseInstruction}

TASK: Deliver a concise 1-sentence reminder message to ${recipientName}.
Strict Rules:
- Deliver the message naturally in your established character and persona.
- Strictly NO emojis.
- Output ONLY the 1 sentence message, nothing else.`,
        prompt: `Deliver this reminder to ${recipientName}: "${event.text}"`,
      });

      if (result.text && result.text.trim()) {
        return result.text.trim().replace(EMOJI_REGEX, '').trim();
      }
    } catch {
      // Safe fallback when LLM generation fails
    }

    return `[Reminder] It is time for: ${event.text}. (${recipientName})`;
  }

  private async synthesizeWebUpdateAlert(
    event: TaskDispatchEvent,
    recipientName: string
  ): Promise<string | null> {
    const baseInstruction = this.personaBuilder.getBaseInstruction();
    const hasPrevious = Boolean(event.previousSnippet?.trim());

    try {
      const result = await this.llmProvider.generate({
        systemInstruction: `${baseInstruction}

TASK: Deliver an informative webpage change notification to ${recipientName} based on newly discovered content.
Strict Rules:
- Deliver the notification naturally in your established character and persona.
- Clearly summarize WHAT is new from the snippet in 1-2 concise sentences.
- Include the URL naturally so the recipient can inspect it.
- Strictly NO emojis.
- Do not treat this as a personal chore/task alarm to be "finished".${
          hasPrevious
            ? `\n- Compare the previous snippet with the new snippet relative to the watch goal. If the only differences are irrelevant dynamic noise (such as live clocks, timestamps, relative time labels, random ads/banners, or unrelated layout churn) and NOT a meaningful update to the watched target, output ONLY "${NO_RELEVANT_CHANGE_MARKER}".`
            : ''
        }`,
        prompt: `${
          hasPrevious
            ? `Previous content snippet:\n"""\n${(event.previousSnippet || '').slice(0, MAX_WATCH_CONTENT_CHARS)}\n"""\n\n`
            : ''
        }Webpage update detected on: "${event.text}" (${event.url || ''}).
Newly detected content snippet:
"""
${(event.diffSnippet || '').slice(0, MAX_WATCH_CONTENT_CHARS)}
"""

Deliver this notification to ${recipientName}:`,
      });

      if (result.text && result.text.trim()) {
        const cleaned = result.text.trim().replace(EMOJI_REGEX, '').trim();
        if (hasPrevious && /^NO_RELEVANT_CHANGE\b/i.test(cleaned)) {
          return null;
        }
        return cleaned;
      }
    } catch {
      // Safe fallback when LLM generation fails
    }

    return `[Web Update] New content detected on ${event.url || ''} (${event.text}):\n"${(event.diffSnippet || '').slice(0, 160)}..."`;
  }
}
