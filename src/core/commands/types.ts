import { CoreResponse, IncomingMessage } from '../types';

/**
 * Deterministic prefix command executed without invoking the conversational LLM pipeline.
 */
export interface BotCommand {
  name: string;
  aliases?: string[];
  description: string;
  ownerOnly?: boolean;
  execute(args: string[], incoming: IncomingMessage): Promise<CoreResponse>;
  /** Optional check for active multi-step command sessions (e.g. awaiting follow-up audio). */
  hasPendingSession?(chatId: string, senderId: string): boolean;
  /** Optional handler for follow-up messages belonging to an active pending session. */
  tryHandlePending?(incoming: IncomingMessage): Promise<CoreResponse | null>;
}
