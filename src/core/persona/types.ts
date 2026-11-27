import { UserRole } from '../types';
import { ChatMessage } from '../providers/types';

export interface MoodState {
  energy: number;
  composure: number;
  affection: number;
  playfulness: number;
  lastInteraction: number;
}

export interface MoodDelta {
  energy?: number;
  composure?: number;
  affection?: number;
  playfulness?: number;
}

export interface InteractionContext {
  userText: string;
  assistantText?: string;
  senderRole: UserRole;
  /** Optional prior conversation messages leading up to the current turn for multi-turn mood evaluation. */
  recentHistory?: ChatMessage[];
}

export interface MoodEvaluator {
  evaluate(context: InteractionContext): Promise<MoodDelta>;
}

/**
 * Shared mood score thresholds used by MoodService directives.
 */
export const MOOD_THRESHOLDS = {
  HIGH_ENERGY: 80,
  LOW_ENERGY: 55,
  HIGH_COMPOSURE: 85,
  LOW_COMPOSURE: 60,
  HIGH_PLAYFULNESS: 75,
  LOW_PLAYFULNESS: 50,
  HIGH_AFFECTION: 80,
  LOW_AFFECTION: 55,
} as const;
