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
