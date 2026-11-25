import { eq, and, lte, gte, inArray } from 'drizzle-orm';
import { AppDatabase } from '../../database';
import { scheduledTasks } from '../../database/schema';
import { Logger } from 'pino';
import { ScheduledTaskItem, ScheduleType, ActionType, ReminderItem, CreateScheduledTaskParams, RecentTaskResult, TaskExecutionUpdate } from './types';

const DEDUPLICATION_WINDOW_MS = 5 * 60 * 1000;

/**
 * Service managing task and reminder persistence, scheduling queries, and deduplication.
 */
export class TaskService {
  constructor(private db: AppDatabase, private logger?: Logger) {}

  private mapRowToScheduledTask(r: typeof scheduledTasks.$inferSelect): ScheduledTaskItem {
    return {
      id: r.id,
      chatId: r.chatId,
      title: r.title,
      scheduleType: r.scheduleType as ScheduleType,
      scheduleConfig: this.safeJsonParse(r.scheduleConfig, {}),
      actionType: r.actionType as ActionType,
      actionPayload: this.safeJsonParse(r.actionPayload, {}),
      lastStateHash: r.lastStateHash,
      lastResultSummary: r.lastResultSummary,
      lastExecutedAt: r.lastExecutedAt,
      nextRunAt: r.nextRunAt,
      expiresAt: r.expiresAt,
      status: r.status as 'active' | 'completed' | 'cancelled',
      createdAt: r.createdAt,
    };
  }

  private safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger?.warn({ err }, '[TaskService] Failed to parse stored JSON payload');
      return fallback;
    }
  }

  /**
   * Creates or deduplicates a scheduled task or reminder.
   */
  async createScheduledTask(params: CreateScheduledTaskParams): Promise<{ id: number; isDuplicate: boolean }> {
    const cleanTitle = params.title.trim();

    const activeTasks = await this.db
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.chatId, params.chatId), eq(scheduledTasks.status, 'active')));

    const duplicate = activeTasks.find((t) => {
      if (t.actionType !== params.actionType) return false;
      if (t.scheduleType !== params.scheduleType) return false;

      if (params.actionType === 'watch_url') {
        const payload = this.safeJsonParse<Record<string, any>>(t.actionPayload, {});
        return payload.url === params.actionPayload.url;
      }

      if (t.scheduleType === 'once') {
        return (
          t.title.toLowerCase() === cleanTitle.toLowerCase() &&
          Math.abs(t.nextRunAt - params.nextRunAt) <= DEDUPLICATION_WINDOW_MS
        );
      }

      return t.title.toLowerCase() === cleanTitle.toLowerCase();
    });

    if (duplicate) {
      this.logger?.info(`[TaskService] Duplicate scheduled task detected for #${duplicate.id}, reusing.`);
      return { id: duplicate.id, isDuplicate: true };
    }

    const result = await this.db.insert(scheduledTasks).values({
      chatId: params.chatId,
      title: cleanTitle,
      scheduleType: params.scheduleType,
      scheduleConfig: JSON.stringify(params.scheduleConfig || {}),
      actionType: params.actionType,
      actionPayload: JSON.stringify(params.actionPayload || {}),
      lastStateHash: null,
      lastResultSummary: null,
      lastExecutedAt: null,
      nextRunAt: params.nextRunAt,
      expiresAt: params.expiresAt || null,
      status: 'active',
      createdAt: Date.now(),
    });

    return { id: Number(result.lastInsertRowid), isDuplicate: false };
  }

  /**
   * Retrieves all scheduled tasks currently due for execution across all chats.
   */
  async getDueScheduledTasks(): Promise<ScheduledTaskItem[]> {
    const now = Date.now();
    const rows = await this.db
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.status, 'active'), lte(scheduledTasks.nextRunAt, now)));

    return rows.map((r) => this.mapRowToScheduledTask(r));
  }

  /**
   * Retrieves all active scheduled tasks for a specific chat.
   */
  async getPendingTasks(chatId: string): Promise<ScheduledTaskItem[]> {
    const rows = await this.db
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.chatId, chatId), eq(scheduledTasks.status, 'active')));

    return rows.map((r) => this.mapRowToScheduledTask(r));
  }

  /**
   * Retrieves active tasks formatted as user-facing reminder items.
   * Leverages getPendingTasks to eliminate query duplication.
   */
  async getPendingReminders(chatId: string, timeZone: string): Promise<ReminderItem[]> {
    const activeTasks = await this.getPendingTasks(chatId);

    return activeTasks.map((t) => {
      let label = t.title;
      if (t.scheduleType === 'daily') {
        const cfg = t.scheduleConfig;
        label = `[Daily Routine ${cfg.targetTime || timeZone}] ${t.title}`;
      } else if (t.scheduleType === 'interval') {
        const cfg = t.scheduleConfig;
        label = `[Interval ${cfg.intervalMinutes || 60}m] ${t.title}`;
      }
      return {
        id: t.id,
        chatId: t.chatId,
        text: label,
        dueTimestamp: t.nextRunAt,
        status: 'pending',
        createdAt: t.createdAt,
      };
    });
  }

  /**
   * Retrieves recently completed reminders within a specified time window.
   */
  async getRecentlyCompletedReminders(
    chatId: string,
    withinMs: number = 2 * 60 * 60 * 1000
  ): Promise<ReminderItem[]> {
    const cutoff = Date.now() - withinMs;
    const completedTasks = await this.db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.chatId, chatId),
          eq(scheduledTasks.status, 'completed'),
          gte(scheduledTasks.nextRunAt, cutoff)
        )
      );

    return completedTasks.map((r) => ({
      id: r.id,
      chatId: r.chatId,
      text: r.title,
      dueTimestamp: r.nextRunAt,
      status: r.status,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Retrieves recent execution results (such as webpage diff summaries) for context injection.
   */
  async getRecentTaskResults(
    chatId: string,
    withinMs: number = 3 * 60 * 60 * 1000
  ): Promise<RecentTaskResult[]> {
    const cutoff = Date.now() - withinMs;
    const rows = await this.db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.chatId, chatId),
          gte(scheduledTasks.lastExecutedAt, cutoff)
        )
      );

    return rows
      .filter((r) => Boolean(r.lastResultSummary))
      .map((r) => {
        const payload = this.safeJsonParse<Record<string, any>>(r.actionPayload, {});
        return {
          id: r.id,
          title: r.title,
          actionType: r.actionType,
          summary: r.lastResultSummary!,
          executedAt: r.lastExecutedAt || r.createdAt,
          url: payload.url,
        };
      });
  }

  /**
   * Cancels an active scheduled task or reminder by its numeric ID.
   */
  async cancelReminder(id: number): Promise<boolean> {
    const resTasks = await this.db
      .update(scheduledTasks)
      .set({ status: 'cancelled' })
      .where(eq(scheduledTasks.id, id));

    return (resTasks.changes ?? 0) > 0;
  }

  /**
   * Cancels active tasks matching a keyword in their title.
   */
  async cancelTaskByKeyword(chatId: string, keyword: string): Promise<{ success: boolean; cancelledItems: string[] }> {
    const cleanKw = keyword.trim().toLowerCase();
    const cancelledItems: string[] = [];

    const activeTasks = await this.db
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.chatId, chatId), eq(scheduledTasks.status, 'active')));

    const matched = activeTasks.filter((t) => t.title.toLowerCase().includes(cleanKw));
    if (matched.length > 0) {
      const matchedIds = matched.map((t) => t.id);
      await this.db
        .update(scheduledTasks)
        .set({ status: 'cancelled' })
        .where(inArray(scheduledTasks.id, matchedIds));
      for (const t of matched) {
        cancelledItems.push(`Task #${t.id}: "${t.title}"`);
      }
    }

    return {
      success: cancelledItems.length > 0,
      cancelledItems,
    };
  }

  /**
   * Purges completed or cancelled tasks older than the retention threshold.
   */
  async purgeOldTasks(olderThanDays: number = 3): Promise<number> {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    try {
      const resTasks = await this.db
        .delete(scheduledTasks)
        .where(
          and(
            inArray(scheduledTasks.status, ['completed', 'cancelled']),
            lte(scheduledTasks.nextRunAt, cutoff)
          )
        );

      return resTasks.changes ?? 0;
    } catch (err) {
      this.logger?.warn(err, 'Failed to purge old completed or cancelled tasks');
      return 0;
    }
  }

  /**
   * Updates task status, next execution timestamp, and outcome summary post-execution.
   */
  async updateTaskAfterExecution(id: number, update: TaskExecutionUpdate): Promise<void> {
    await this.db
      .update(scheduledTasks)
      .set({
        status: update.status,
        nextRunAt: update.nextRunAt,
        lastStateHash: update.lastStateHash,
        lastResultSummary: update.lastResultSummary,
        lastExecutedAt: update.lastExecutedAt,
      })
      .where(eq(scheduledTasks.id, id));
  }
}
