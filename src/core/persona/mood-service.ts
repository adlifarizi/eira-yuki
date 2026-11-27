import { eq } from 'drizzle-orm';
import { AppDatabase } from '../../database';
import { botMood } from '../../database/schema';
import { UserRole } from '../types';
import { MOOD_THRESHOLDS, MoodDelta, MoodState } from './types';
import { Logger } from 'pino';

export * from './types';

const GUEST_DEFAULT_AFFECTION = 50;

/**
 * Service managing bot emotional state, diurnal time dynamics, and persona mood modifiers.
 */
export class MoodService {
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(private db: AppDatabase, private logger?: Logger) {}

  /**
   * Retrieves the current mood state after applying diurnal time dynamics.
   * Serialized through `updateQueue` to prevent races with concurrent `applyDelta` calls.
   * Guests receive a neutral affection baseline.
   */
  async getMood(role: UserRole = 'owner'): Promise<MoodState> {
    const task = this.updateQueue.then(async () => {
      const raw = await this.getRawMood();
      const adjusted = await this.applyTimeDynamics(raw);

      if (role === 'guest') {
        return {
          ...adjusted,
          affection: GUEST_DEFAULT_AFFECTION,
        };
      }

      return adjusted;
    });

    this.updateQueue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  /**
   * Applies an incremental mood delta and persists the updated state.
   * Serialized through `updateQueue` to prevent lost updates.
   */
  async applyDelta(delta: MoodDelta, role: UserRole = 'owner'): Promise<MoodState> {
    const task = this.updateQueue.then(async () => {
      const raw = await this.getRawMood();
      const now = Date.now();

      const energyDelta = delta.energy ?? 0;
      const composureDelta = delta.composure ?? 0;
      const playfulnessDelta = delta.playfulness ?? 0;
      const affectionDelta = role === 'guest' ? 0 : (delta.affection ?? 0);

      const clamp = (val: number) => Math.max(0, Math.min(100, val));

      const updated: MoodState = {
        energy: clamp(raw.energy + energyDelta),
        composure: clamp(raw.composure + composureDelta),
        affection: clamp(raw.affection + affectionDelta),
        playfulness: clamp(raw.playfulness + playfulnessDelta),
        lastInteraction: now,
      };

      await this.db.update(botMood).set(updated).where(eq(botMood.id, 1));

      if (role === 'guest') {
        return {
          ...updated,
          affection: GUEST_DEFAULT_AFFECTION,
        };
      }

      return updated;
    });

    this.updateQueue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  /**
   * Formats current mood state into system prompt directives.
   *
   * @param timeZone - Mandatory IANA time zone identifier for hour-based diurnal directives.
   */
  formatMoodDescription(
    mood: MoodState,
    role: UserRole = 'owner',
    timeZone: string
  ): string {
    let localHour: number;
    try {
      // Use 'en-US-u-nu-latn' with hourCycle 'h23' to guarantee ASCII digits 0-23 (never 24 at midnight).
      const formatted = new Intl.DateTimeFormat('en-US-u-nu-latn', {
        hour: 'numeric',
        hourCycle: 'h23',
        timeZone,
      }).format(new Date());
      localHour = parseInt(formatted, 10);
    } catch {
      localHour = new Date().getHours();
    }

    const directives: string[] = [];

    if (localHour >= 23 || localHour < 5) {
      directives.push(
        'Late Night: You feel slightly drowsy, calm, or wondering why your master is still awake at this hour.'
      );
    } else if (localHour >= 5 && localHour < 9) {
      directives.push(
        'Early Morning: Freshly awake, crisp, composed, ready for the day ahead.'
      );
    }

    if (mood.energy >= MOOD_THRESHOLDS.HIGH_ENERGY) {
      directives.push('High Energy: Intellectually alert, composed, sharp, and quick to respond.');
    } else if (mood.energy < MOOD_THRESHOLDS.LOW_ENERGY) {
      directives.push('Low Energy: Sluggish, brief, and concise; not inclined to use extra words.');
    }

    if (mood.composure >= MOOD_THRESHOLDS.HIGH_COMPOSURE) {
      directives.push('High Composure: Poised, calm, and unflappable.');
    } else if (mood.composure < MOOD_THRESHOLDS.LOW_COMPOSURE) {
      directives.push(
        'Low Composure: Slightly terse and matter-of-fact; maintain boundaries calmly without snapping or insulting.'
      );
    }

    if (mood.playfulness >= MOOD_THRESHOLDS.HIGH_PLAYFULNESS) {
      directives.push(
        'High Playfulness: Light, dryly amusing, and warm-deadpan wit—never sarcastic, mean, or condescending.'
      );
    } else if (mood.playfulness < MOOD_THRESHOLDS.LOW_PLAYFULNESS) {
      directives.push('Low Playfulness: Serious, direct, and purely pragmatic.');
    }

    if (role === 'guest') {
      directives.push(
        'Guest Boundary: Maintain a professional, polite, and reserved distance. Do not express personal warmth or deep loyalty.'
      );
    } else {
      if (mood.affection >= MOOD_THRESHOLDS.HIGH_AFFECTION) {
        directives.push(
          'High Affection: Deeply loyal and quietly protective; subtle warmth and care hidden beneath your composed exterior.'
        );
      } else if (mood.affection < MOOD_THRESHOLDS.LOW_AFFECTION) {
        directives.push(
          'Low/Cold Affection: Distant, skeptical, coolly unimpressed, and reserved.'
        );
      }
    }

    return `[CURRENT EMOTIONAL STATE & MOOD MODIFIERS]
- Energy: ${mood.energy}% | Composure: ${mood.composure}% | Affection: ${mood.affection}% | Playfulness: ${mood.playfulness}%
- Behavioral Directives:
${directives.map((d) => `  * ${d}`).join('\n')}
(Naturally embody these emotional nuances through your established persona).`;
  }

  private async getRawMood(): Promise<MoodState> {
    const rows = await this.db.select().from(botMood).where(eq(botMood.id, 1));
    if (rows.length === 0) {
      const initial: MoodState = {
        energy: 85,
        composure: 90,
        affection: 75,
        playfulness: 80,
        lastInteraction: Date.now(),
      };
      await this.db.insert(botMood).values({ id: 1, ...initial }).onConflictDoNothing();
      const inserted = await this.db.select().from(botMood).where(eq(botMood.id, 1));
      return inserted[0] ?? initial;
    }
    return rows[0];
  }

  private async applyTimeDynamics(raw: MoodState): Promise<MoodState> {
    const now = Date.now();
    const hoursSinceLast = (now - raw.lastInteraction) / (1000 * 60 * 60);

    if (hoursSinceLast < 1) {
      return raw;
    }

    let energy = raw.energy;
    let composure = raw.composure;
    let playfulness = raw.playfulness;

    if (hoursSinceLast >= 6) {
      energy = Math.max(energy, 85);
      composure = Math.max(composure, 90);
      playfulness = Math.round(playfulness + (75 - playfulness) * 0.3);
    } else {
      composure = Math.min(90, composure + Math.floor(hoursSinceLast * 4));
    }

    if (
      energy !== raw.energy ||
      composure !== raw.composure ||
      playfulness !== raw.playfulness
    ) {
      const updated: MoodState = {
        ...raw,
        energy,
        composure,
        playfulness,
        lastInteraction: now,
      };
      await this.db.update(botMood).set(updated).where(eq(botMood.id, 1));
      return updated;
    }

    return raw;
  }
}
