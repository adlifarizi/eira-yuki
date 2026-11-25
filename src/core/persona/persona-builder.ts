import { IncomingMessage } from '../types';

const DEFAULT_BASE_INSTRUCTION = 'You are Eira Yuki, a personal autonomous AI companion.';

/**
 * Builds the base persona system instruction and role perception (Owner vs Guest).
 * Focused strictly on character, identity, tone of voice, and boundary guidelines.
 */
export class PersonaBuilder {
  private readonly baseInstruction: string;

  constructor(baseInstruction?: string) {
    this.baseInstruction = baseInstruction?.trim() || DEFAULT_BASE_INSTRUCTION;
  }

  getBaseInstruction(): string {
    return this.baseInstruction;
  }

  buildPersona(msg: IncomingMessage): string {
    const base = this.getBaseInstruction();

    const roleGuidance =
      msg.role === 'owner'
        ? `
[SENDER ROLE: MASTER / PRIMARY OWNER]
- Sender "${msg.senderName}" (${msg.senderId}) is your PRIMARY OWNER and MASTER.
- Interact with the sender naturally in your established character and persona.
- You have full clearance to execute all personal tools, manage owner reminders, and discuss personal matters.
`.trim()
        : `
[SENDER ROLE: GUEST / SOCIAL CHAT]
- Sender "${msg.senderName}" (${msg.senderId}) is a GUEST / STRANGER (not Owner).
- Strictly safeguard your Owner's privacy and personal data.
- Never disclose private facts or sensitive credentials of your Owner.
- Answer general inquiries politely in your established persona.
`.trim();

    return `${base}\n\n${roleGuidance}`;
  }
}
