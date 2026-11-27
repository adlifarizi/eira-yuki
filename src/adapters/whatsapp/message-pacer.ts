const DEFAULT_MAX_BUBBLES = 3;
const MIN_SENTENCE_SPLIT_LENGTH = 80;
const MIN_TYPING_DELAY_MS = 600;
const MAX_TYPING_DELAY_MS = 1500;
const BASE_TYPING_DELAY_MS = 450;
const MS_PER_CHAR = 12;

/**
 * Splits a reply into up to `maxBubbles` natural WhatsApp chat bubbles.
 * Prefers paragraph boundaries first, then falls back to `Intl.Segmenter` sentence
 * boundaries for longer single-paragraph replies while keeping lists and URLs intact.
 */
export function splitIntoBubbles(
  text: string,
  locale: string,
  maxBubbles: number = DEFAULT_MAX_BUBBLES
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const limit = Math.max(1, maxBubbles);
  if (limit === 1) return [trimmed];

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length > 1) {
    return capSegments(paragraphs, limit, '\n\n');
  }

  // Keep lists, URLs, and short replies together as a single bubble.
  if (
    trimmed.length <= MIN_SENTENCE_SPLIT_LENGTH ||
    /^\s*(?:[-*]|\d+\.)\s+/m.test(trimmed) ||
    /https?:\/\//i.test(trimmed)
  ) {
    return [trimmed];
  }

  const sentences = segmentSentences(trimmed, locale);
  if (sentences.length <= 1) {
    return [trimmed];
  }

  return capSegments(sentences, limit, ' ');
}

/**
 * Computes a natural typing pause duration (600-1500 ms) proportional to the
 * length of the upcoming chat bubble.
 */
export function computeTypingDelayMs(nextBubbleText: string): number {
  const raw = BASE_TYPING_DELAY_MS + nextBubbleText.trim().length * MS_PER_CHAR;
  return Math.min(MAX_TYPING_DELAY_MS, Math.max(MIN_TYPING_DELAY_MS, raw));
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function segmentSentences(text: string, locale: string): string[] {
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  } catch {
    segmenter = new Intl.Segmenter('en-US', { granularity: 'sentence' });
  }

  const segments: string[] = [];
  for (const part of segmenter.segment(text)) {
    const cleaned = part.segment.trim();
    if (cleaned) {
      segments.push(cleaned);
    }
  }
  return segments;
}

function capSegments(segments: string[], maxBubbles: number, joiner: string): string[] {
  if (segments.length <= maxBubbles) {
    return segments;
  }

  const head = segments.slice(0, maxBubbles - 1);
  const tail = segments.slice(maxBubbles - 1).join(joiner);
  return [...head, tail];
}
