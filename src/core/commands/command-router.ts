import { Logger } from 'pino';
import { CoreResponse, IncomingMessage } from '../types';
import { BotCommand } from './types';

/**
 * Parses and dispatches deterministic prefix commands before messages reach the LLM agent.
 */
export class CommandRouter {
  private readonly commands = new Map<string, BotCommand>();
  private readonly aliasMap = new Map<string, string>();

  constructor(
    private readonly prefix: string = '.',
    private readonly logger?: Logger
  ) {}

  getPrefix(): string {
    return this.prefix;
  }

  register(command: BotCommand): void {
    const normalizedName = command.name.trim().toLowerCase();
    this.commands.set(normalizedName, command);
    this.aliasMap.set(normalizedName, normalizedName);

    for (const alias of command.aliases ?? []) {
      const normalizedAlias = alias.trim().toLowerCase();
      if (normalizedAlias) {
        this.aliasMap.set(normalizedAlias, normalizedName);
      }
    }
  }

  registerAll(commands: BotCommand[]): void {
    for (const cmd of commands) {
      this.register(cmd);
    }
  }

  getCommands(): BotCommand[] {
    return Array.from(this.commands.values());
  }

  /**
   * Returns true only when `text` starts with the configured prefix and resolves to a
   * registered command name or alias, preventing false triggers on normal punctuation.
   */
  isRegisteredCommand(text: string): boolean {
    return this.parseCommand(text) !== null;
  }

  /**
   * Returns true when the given sender in a chat has an active multi-step command session.
   */
  hasPendingInteraction(chatId: string, senderId: string): boolean {
    for (const cmd of this.commands.values()) {
      if (cmd.hasPendingSession?.(chatId, senderId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Executes a matching registered command or active pending session and returns its response,
   * or `null` if the message should continue to the conversational agent.
   */
  async tryExecute(incoming: IncomingMessage): Promise<CoreResponse | null> {
    const parsed = this.parseCommand(incoming.text);
    if (!parsed) {
      for (const cmd of this.commands.values()) {
        if (cmd.tryHandlePending) {
          const pendingResult = await cmd.tryHandlePending(incoming);
          if (pendingResult) {
            return pendingResult;
          }
        }
      }
      return null;
    }

    const { command, args } = parsed;
    if (command.ownerOnly && incoming.role !== 'owner') {
      return { text: 'Perintah ini hanya dapat digunakan oleh Owner.' };
    }

    this.logger?.debug(
      { command: command.name, chatId: incoming.chatId, role: incoming.role },
      '[CommandRouter] Executing prefix command'
    );

    return command.execute(args, incoming);
  }

  private parseCommand(text: string): { command: BotCommand; args: string[] } | null {
    const trimmed = text?.trim();
    if (!trimmed || !trimmed.startsWith(this.prefix)) {
      return null;
    }

    const withoutPrefix = trimmed.slice(this.prefix.length);
    if (!withoutPrefix || /^\s/.test(withoutPrefix)) {
      return null;
    }

    const parts = withoutPrefix.split(/\s+/);
    const rawName = parts[0]?.toLowerCase();
    if (!rawName) {
      return null;
    }

    const canonicalName = this.aliasMap.get(rawName);
    if (!canonicalName) {
      return null;
    }

    const command = this.commands.get(canonicalName);
    if (!command) {
      return null;
    }

    return { command, args: parts.slice(1) };
  }
}
