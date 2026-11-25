import { UserRole } from '../types';

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
}

export interface MoodEvaluator {
  evaluate(context: InteractionContext): Promise<MoodDelta>;
}
