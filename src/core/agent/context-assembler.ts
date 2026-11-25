import { Logger } from 'pino';
import { IncomingMessage } from '../types';
import { ChatMessage } from '../providers';
import { CoreTool, ToolDefinition, ToolRegistry } from '../tools';
import { PersonaBuilder, MoodService } from '../persona';
import { MemoryService } from '../memory';
import { TaskService } from '../scheduler';
const RECENT_EVENTS_WINDOW_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_MAX_HISTORY_LIMIT = 30;

export interface ContextAssemblerOptions {
  personaBuilder: PersonaBuilder;
  toolRegistry: ToolRegistry;
  timeZone: string;
  locale: string;
  memoryService?: MemoryService;
  moodService?: MoodService;
  taskService?: TaskService;
  logger?: Logger;
  maxHistoryLimit?: number;
  recentEventsWindowMs?: number;
  conversationGapThresholdMinutes?: number;
}

export interface AssembledAgentContext {
  systemInstruction: string;
  prompt: string;
  conversationHistory: ChatMessage[];
  tools: ToolDefinition[];
}

/**
 * Assembles the complete prompt context for a conversation turn, including persona,
 * active reminders, mood state, long-term memory, and recent chat history.
 */
export class ContextAssembler {
  private timeZone: string;
  private locale: string;
  private readonly recentEventsWindowMs: number;
  private readonly conversationGapThresholdMinutes: number;

  constructor(private options: ContextAssemblerOptions) {
    this.timeZone = options.timeZone;
    this.locale = options.locale;
    this.recentEventsWindowMs = options.recentEventsWindowMs ?? RECENT_EVENTS_WINDOW_MS;
    this.conversationGapThresholdMinutes = options.conversationGapThresholdMinutes ?? 3;
  }

  /**
   * Builds the system instruction, formatted prompt, conversation history, and tool definitions
   * for an incoming message.
   */
  async assemble(incoming: IncomingMessage): Promise<AssembledAgentContext> {
    const activeReminders = await this.fetchActiveReminders(incoming.chatId);
    const completedReminders = await this.fetchCompletedReminders(incoming.chatId);
    const timeElapsedMinutes = await this.calculateTimeElapsed(incoming);
    const recentTaskResults = await this.fetchRecentTaskResults(incoming.chatId);

    const personaContext = this.options.personaBuilder.buildPersona(incoming);
    const interactionContext = this.buildInteractionContext(incoming, timeElapsedMinutes);
    const activeTools = this.options.toolRegistry.getToolsForRole(incoming.role);
    const operationalInvariants = this.buildOperationalInvariants(activeTools);
    const remindersContext = this.buildRemindersContext(activeReminders);
    const completedRemindersContext = this.buildCompletedRemindersContext(completedReminders);
    const taskResultsContext = this.buildTaskResultsContext(recentTaskResults);

    const sections: string[] = [
      personaContext,
      interactionContext,
      operationalInvariants,
    ];

    if (remindersContext) sections.push(remindersContext);
    if (completedRemindersContext) sections.push(completedRemindersContext);
    if (taskResultsContext) sections.push(taskResultsContext);

    if (this.options.moodService) {
      try {
        const mood = await this.options.moodService.getMood(incoming.role);
        sections.push(
          this.options.moodService.formatMoodDescription(
            mood,
            incoming.role,
            this.timeZone
          )
        );
      } catch (err) {
        this.options.logger?.warn({ err }, 'Failed to load mood context');
      }
    }

    let conversationHistory: ChatMessage[] = [];
    if (this.options.memoryService) {
      try {
        const memoryContext = await this.options.memoryService.buildMemoryContext(
          incoming.text,
          incoming.role,
          incoming.chatId
        );
        if (memoryContext) {
          sections.push(memoryContext);
        }
      } catch (err) {
        this.options.logger?.warn({ err }, 'Failed to build long-term memory context');
      }

      try {
        conversationHistory = await this.options.memoryService.getRecentChatHistory(
          incoming.chatId,
          this.options.maxHistoryLimit ?? DEFAULT_MAX_HISTORY_LIMIT
        );
      } catch (err) {
        this.options.logger?.warn({ err }, 'Failed to load recent chat history');
      }
    }

    const tools: ToolDefinition[] = activeTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    let promptText = incoming.text;
    if (incoming.quotedMessage) {
      promptText = `[Replied/Quoted Message]:\n"${incoming.quotedMessage.text}"\n\n[User Message]:\n${incoming.text || '(Respond to the quoted message above)'}`;
    }

    return {
      systemInstruction: sections.join('\n\n'),
      prompt: promptText,
      conversationHistory,
      tools,
    };
  }

  private buildInteractionContext(incoming: IncomingMessage, timeElapsedMinutes?: number): string {
    const now = new Date(incoming.timestamp || Date.now());
    const timeStr = now.toLocaleTimeString(this.locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: this.timeZone,
    });
    const dateStr = now.toLocaleDateString(this.locale, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: this.timeZone,
    });

    const timeGapContext =
      timeElapsedMinutes && timeElapsedMinutes >= this.conversationGapThresholdMinutes
        ? `- Time elapsed since last message: ${
            timeElapsedMinutes >= 60
              ? `${Math.floor(timeElapsedMinutes / 60)}h ${timeElapsedMinutes % 60}m`
              : `${timeElapsedMinutes}m`
          } ago (The previous conversation turn ended earlier; this new message is not an immediate split-second continuation).`
        : '';

    return `
[INTERACTION CONTEXT]
- Current Date/Time: ${dateStr}, ${timeStr} (${this.timeZone})
- Chat Type: ${incoming.chatType === 'group' ? 'Group Chat' : 'Direct Message (DM)'}
- Chat ID: ${incoming.chatId}
${timeGapContext ? timeGapContext : ''}
`.trim();
  }

  private buildOperationalInvariants(activeTools: CoreTool[]): string {
    const sections: string[] = [
      `[TOOL & OPERATIONAL ACTION INVARIANTS (STRICT)]
- You have autonomous access to backend operational tools.
- PHYSICALITY INVARIANT: Plain conversational text CANNOT modify databases, set alarms, or perform real-world actions. If the user asks to perform an action, schedule a task, monitor a webpage, or cancel an item, you MUST emit the appropriate function call.
- ANTI-PHANTOM EXECUTION: NEVER claim or promise that an action is scheduled, monitored, or cancelled in text unless you ACTUALLY executed the corresponding function call in this turn.
- Only call tools when relevant. Do not duplicate actions.`.trim(),
    ];

    const directives = activeTools
      .filter((t) => t.operationalDirective)
      .map((t) => `- [${t.name}]: ${t.operationalDirective}`);

    if (directives.length > 0) {
      sections.push(`[SPECIFIC TOOL DIRECTIVES]\n${directives.join('\n')}`);
    }

    return sections.join('\n\n');
  }

  private buildRemindersContext(
    activeReminders?: { id: number; text: string; dueAt: string }[]
  ): string | undefined {
    if (!activeReminders || activeReminders.length === 0) return undefined;
    return `
[ACTIVE SCHEDULED REMINDERS]
${activeReminders.map((r) => `- ID #${r.id}: "${r.text}" (Due: ${r.dueAt})`).join('\n')}
* CRITICAL ANTI-DUPLICATION RULE: The reminders above are ALREADY active and scheduled in the system database. DO NOT call "set_reminder" again for any item already listed above or already requested earlier in the chat history. Only call "set_reminder" if the user explicitly asks for a NEW or DIFFERENT reminder. If user asks to cancel, delete, or dismiss an active reminder, call "cancel_reminder" with its ID or keyword.
`.trim();
  }

  private buildCompletedRemindersContext(
    completedReminders?: { id: number; text: string; completedAt: string }[]
  ): string | undefined {
    if (!completedReminders || completedReminders.length === 0) return undefined;
    return `
[COMPLETED RECENT REMINDERS & EVENTS]
${completedReminders.map((r) => `- ID #${r.id}: "${r.text}" (Delivered: ${r.completedAt})`).join('\n')}
* IMPORTANT: The reminders listed above were ALREADY successfully delivered to the user at the noted time. DO NOT re-announce, wait for, or repeat them. Treat them as completely resolved.
`.trim();
  }

  private buildTaskResultsContext(
    recentTaskResults?: { id: number; title: string; actionType: string; summary: string; executedAt: string; url?: string }[]
  ): string | undefined {
    if (!recentTaskResults || recentTaskResults.length === 0) return undefined;
    return `
[RECENT BACKGROUND TASK EXECUTION OUTPUTS]
${recentTaskResults.map((t) => `- Task #${t.id} (${t.actionType}${t.url ? `: ${t.url}` : ''}) [${t.executedAt}]: "${t.summary}"`).join('\n')}
* CONVERSATIONAL AWARENESS DIRECTIVE: The background events above were recently executed and dispatched by you to the user. If the user refers to these updates (e.g. asking "what is new", "what was that content earlier", or discussing the findings), utilize the exact context above to answer accurately and naturally.
`.trim();
  }

  private formatTimestamp(timestamp: number | string | Date): string {
    return new Date(timestamp).toLocaleTimeString(this.locale, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: this.timeZone,
      timeZoneName: 'short',
    });
  }

  private async fetchActiveReminders(chatId: string) {
    if (!this.options.taskService) return undefined;
    try {
      const pending = await this.options.taskService.getPendingReminders(chatId, this.timeZone);
      if (pending.length === 0) return undefined;

      return pending.map((r) => ({
        id: r.id,
        text: r.text,
        dueAt: this.formatTimestamp(r.dueTimestamp),
      }));
    } catch (err) {
      this.options.logger?.warn({ err }, 'Failed to fetch active reminders');
      return undefined;
    }
  }

  private async fetchCompletedReminders(chatId: string) {
    if (!this.options.taskService) return undefined;
    try {
      const completed = await this.options.taskService.getRecentlyCompletedReminders(
        chatId,
        this.recentEventsWindowMs
      );
      if (completed.length === 0) return undefined;

      return completed.map((r) => ({
        id: r.id,
        text: r.text,
        completedAt: this.formatTimestamp(r.dueTimestamp),
      }));
    } catch (err) {
      this.options.logger?.warn({ err }, 'Failed to fetch completed reminders');
      return undefined;
    }
  }

  private async calculateTimeElapsed(incoming: IncomingMessage): Promise<number | undefined> {
    if (!this.options.memoryService) return undefined;
    try {
      const lastTimestamp = await this.options.memoryService.getLastMessageTimestamp(incoming.chatId);
      if (!lastTimestamp) return undefined;

      const currentTimestamp = incoming.timestamp || Date.now();
      const diffMs = currentTimestamp - lastTimestamp;
      return diffMs > 0 ? Math.floor(diffMs / 60000) : undefined;
    } catch (err) {
      this.options.logger?.warn({ err }, 'Failed to calculate time elapsed since last message');
      return undefined;
    }
  }

  private async fetchRecentTaskResults(chatId: string) {
    if (!this.options.taskService) return undefined;
    try {
      const rawResults = await this.options.taskService.getRecentTaskResults(
        chatId,
        this.recentEventsWindowMs
      );
      if (rawResults.length === 0) return undefined;

      return rawResults.map((r) => ({
        id: r.id,
        title: r.title,
        actionType: r.actionType,
        summary: r.summary,
        url: r.url,
        executedAt: this.formatTimestamp(r.executedAt),
      }));
    } catch (err) {
      this.options.logger?.warn({ err }, 'Failed to fetch recent task results');
      return undefined;
    }
  }
}
