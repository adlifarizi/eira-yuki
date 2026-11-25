import { CoreTool } from './types';
import { TaskService, calculateNextDailyTimestamp } from '../scheduler';

function parseSafeNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const match = trimmed.match(/^-?\d+(?:\.\d+)?/);
    if (match) {
      const parsed = parseFloat(match[0]);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
  return undefined;
}

function formatDueTime(timestamp: number, timeZone: string, locale: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  });
}

export interface ReminderToolOptions {
  timeZone: string;
  locale: string;
}

/**
 * Creates the `set_reminder` tool for scheduling reminders, alarms, and webpage watch monitors.
 *
 * @param taskService - Task service managing scheduling and persistence
 * @param options - Locale and timezone options for due time formatting
 * @returns Core tool instance for setting reminders
 */
export function createSetReminderTool(
  taskService: TaskService,
  options: ReminderToolOptions
): CoreTool {
  const tz = options.timeZone;
  const loc = options.locale;

  return {
    name: 'set_reminder',
    description:
      'Schedule a reminder, alarm, recurring task, or periodic webpage change check (watch_url). ALWAYS invoke this function whenever the user asks to be reminded, alerted, or to monitor/watch a website or task on a schedule.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The task, note, or event to remember or watch (e.g. "buy eggs", "check product price", "check github issues").',
        },
        delayMinutes: {
          type: 'number',
          description: 'Relative delay in minutes from now (e.g. 15 for 15 minutes from now). Use when user specifies a duration.',
        },
        targetTime: {
          type: 'string',
          description: 'Specific target time in 24-hour HH:mm format (e.g. "15:55", "16:00", "08:30"). Use when user mentions a specific clock time.',
        },
        advanceMinutes: {
          type: 'number',
          description: 'Minutes to advance the alarm prior to the target time (e.g. 15 to remind 15 mins before a meeting/flight). Default 0 (on-time).',
        },
        repeatType: {
          type: 'string',
          enum: ['once', 'daily', 'interval'],
          description: 'Schedule frequency: "once" (one-time alarm), "daily" (every day at targetTime), or "interval" (repeats every intervalMinutes). Default "once".',
        },
        intervalMinutes: {
          type: 'number',
          description: 'Repeat interval in minutes if repeatType is "interval" (e.g. 120 for every 2 hours).',
        },
        durationDays: {
          type: 'number',
          description: 'Lifespan in days before the schedule auto-expires (e.g. 3 for "check for 3 days"). Optional.',
        },
        url: {
          type: 'string',
          description: 'Optional URL to watch. If provided, Eira periodically checks this webpage for content changes and alerts upon delta.',
        },
      },
      required: ['text'],
    },
    ownerOnly: false,
    execute: async (params, context) => {
      const advance = Math.max(0, parseSafeNumber(params.advanceMinutes) ?? 0);
      let repeatType = (params.repeatType || 'once') as 'once' | 'daily' | 'interval';

      const parsedInterval = parseSafeNumber(params.intervalMinutes);
      if (!params.repeatType) {
        if (params.url) {
          repeatType = params.targetTime ? 'daily' : 'interval';
        } else if (parsedInterval) {
          repeatType = 'interval';
        }
      }

      let dueTimestamp: number;
      if (params.targetTime && typeof params.targetTime === 'string') {
        dueTimestamp = calculateNextDailyTimestamp(params.targetTime, advance, tz);
      } else if (params.url && !params.delayMinutes) {
        dueTimestamp = Date.now() + 10 * 1000;
      } else {
        const parsedDelay = parseSafeNumber(params.delayMinutes);
        const minutes = parsedDelay ?? (repeatType === 'interval' ? parsedInterval ?? 60 : 1);
        const netMinutes = Math.max(0.5, minutes - advance);
        dueTimestamp = Date.now() + netMinutes * 60 * 1000;
      }

      const parsedDuration = parseSafeNumber(params.durationDays);
      const expiresAt = parsedDuration ? Date.now() + parsedDuration * 24 * 60 * 60 * 1000 : null;

      const actionType = params.url ? 'watch_url' : 'reminder';
      const taskResult = await taskService.createScheduledTask({
        chatId: context.chatId,
        title: params.text,
        scheduleType: repeatType,
        scheduleConfig: {
          targetTime: params.targetTime,
          intervalMinutes: parsedInterval,
          advanceMinutes: advance > 0 ? advance : undefined,
        },
        actionType,
        actionPayload: {
          url: params.url,
          text: params.text,
        },
        nextRunAt: dueTimestamp,
        expiresAt,
      });

      return {
        status: taskResult.isDuplicate ? 'already_scheduled' : 'scheduled',
        taskId: taskResult.id,
        title: params.text,
        scheduleType: repeatType,
        nextRunAt: formatDueTime(dueTimestamp, tz, loc),
        targetTime: params.targetTime || undefined,
        intervalMinutes: parsedInterval || undefined,
        durationDays: parsedDuration || undefined,
        watchUrl: params.url || undefined,
        advanceMinutes: advance > 0 ? advance : undefined,
        delayMinutes: parseSafeNumber(params.delayMinutes) || undefined,
        message: taskResult.isDuplicate
          ? 'A similar schedule is already active in the database.'
          : 'Scheduled task successfully registered.',
      };
    },
  };
}

/**
 * Creates the `cancel_reminder` tool for cancelling scheduled tasks or reminders.
 *
 * @param taskService - Task service managing scheduling and cancellation
 * @returns Core tool instance for cancelling reminders
 */
export function createCancelReminderTool(taskService: TaskService): CoreTool {
  return {
    name: 'cancel_reminder',
    description:
      'Cancel, stop, delete, or dismiss an active scheduled reminder, alarm, or webpage monitoring task by numeric ID or matching keyword. ALWAYS invoke this tool when the user asks to cancel, remove, or stop scheduled tasks.',
    parameters: {
      type: 'object',
      properties: {
        reminderId: {
          type: 'number',
          description: 'The numeric ID of the reminder or task to cancel.',
        },
        keyword: {
          type: 'string',
          description: 'Search keyword to find and cancel matching reminders if ID is unknown (e.g. "eggs", "laundry", "github").',
        },
      },
    },
    ownerOnly: false,
    execute: async (params, context) => {
      const parsedId = parseSafeNumber(params.reminderId);
      if (parsedId !== undefined) {
        const success = await taskService.cancelReminder(parsedId);
        if (success) {
          return {
            status: 'cancelled',
            reminderId: parsedId,
            message: `Reminder #${parsedId} successfully cancelled.`,
          };
        }
        return {
          status: 'not_found',
          reminderId: parsedId,
          message: `Reminder #${parsedId} not found or already completed.`,
        };
      }

      if (params.keyword && typeof params.keyword === 'string') {
        const result = await taskService.cancelTaskByKeyword(context.chatId, params.keyword);
        if (result.success) {
          return {
            status: 'cancelled',
            message: `Successfully cancelled: ${result.cancelledItems.join(', ')}`,
          };
        }
        return {
          status: 'not_found',
          message: `No active reminders found matching keyword "${params.keyword}".`,
        };
      }

      return {
        status: 'error',
        message: 'Please provide a reminderId or keyword to cancel.',
      };
    },
  };
}

/**
 * Creates the `list_reminders` tool for retrieving active schedules in the current chat.
 *
 * @param taskService - Task service managing schedules
 * @param options - Locale and timezone options for due time formatting
 * @returns Core tool instance for listing reminders
 */
export function createListRemindersTool(
  taskService: TaskService,
  options: ReminderToolOptions
): CoreTool {
  const tz = options.timeZone;
  const loc = options.locale;

  return {
    name: 'list_reminders',
    description: 'Display all active, pending reminders and recurring tasks currently scheduled for this chat.',
    parameters: {
      type: 'object',
      properties: {},
    },
    ownerOnly: false,
    execute: async (_params, context) => {
      const active = await taskService.getPendingReminders(context.chatId, tz);
      if (active.length === 0) {
        return { status: 'empty', message: 'No active reminders currently scheduled.' };
      }

      return {
        status: 'active',
        reminders: active.map((r) => {
          return { id: r.id, text: r.text, dueAt: formatDueTime(r.dueTimestamp, tz, loc) };
        }),
      };
    },
  };
}

/**
 * Creates and bundles all reminder-related tools (set_reminder, cancel_reminder, and list_reminders).
 *
 * @param taskService - Task service managing reminders and tasks
 * @param options - Locale and timezone options for due time formatting
 * @returns Array of core tools for task and reminder management
 */
export function createReminderTools(
  taskService: TaskService,
  options: ReminderToolOptions
): CoreTool[] {
  return [
    createSetReminderTool(taskService, options),
    createCancelReminderTool(taskService),
    createListRemindersTool(taskService, options),
  ];
}
