import { IncomingMessage, BotOwners } from '../types';

/**
 * Escapes special regular expression characters in a literal string.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Access control and routing gatekeeper.
 * Validates message authorization against adapter-namespaced bot owners
 * and determines response eligibility based on chat session type and bot mention aliases.
 */
export class PermissionGatekeeper {
  private readonly aliasPatterns: RegExp[];

  /**
   * Initializes the permission gatekeeper with explicit owner records and bot aliases.
   */
  constructor(
    private owners: BotOwners,
    botAliases: string[]
  ) {
    this.aliasPatterns = botAliases
      .map((alias) => alias.trim())
      .filter(Boolean)
      .map((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i'));
  }

  /**
   * Checks whether a sender ID is registered as an owner for the given adapter (or any adapter).
   */
  isOwner(senderId: string, adapter?: string): boolean {
    const trimmedSender = senderId?.trim();
    if (!trimmedSender) return false;

    if (adapter) {
      const adapterOwners = this.owners[adapter] ?? [];
      return adapterOwners.some((owner) => owner.trim() === trimmedSender);
    }

    return Object.values(this.owners).some((adapterOwners) =>
      adapterOwners.some((owner) => owner.trim() === trimmedSender)
    );
  }

  /**
   * Determines whether the bot should respond to an incoming message based on chat type,
   * direct mention, registered prefix command, or configured bot aliases.
   */
  shouldRespond(
    msg: IncomingMessage,
    isDirectlyAddressed: boolean = false,
    isRegisteredCommand: boolean = false
  ): boolean {
    if (msg.chatType === 'dm' || isDirectlyAddressed || isRegisteredCommand) {
      return true;
    }

    const lowerText = msg.text?.trim().toLowerCase();
    if (!lowerText) {
      return false;
    }

    return this.aliasPatterns.some((pattern) => pattern.test(lowerText));
  }
}
