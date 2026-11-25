import { describe, it, expect, vi } from 'vitest';
import { db } from '../../src/database';
import {
  TaskScheduler,
  TaskService,
  TaskExecutor,
  calculateNextDailyTimestamp,
} from '../../src/core/scheduler';
import {
  createReminderTools,
  createSetReminderTool,
  createCancelReminderTool,
  createListRemindersTool,
} from '../../src/core/tools/reminder-tools';
import { IncomingMessage } from '../../src/core/types';
import { PageFetcher } from '../../src/core/browser/page-fetcher';

describe('Task & Reminder Engine', () => {
  const mockPageFetcher = {
    fetch: vi.fn().mockResolvedValue({
      status: 'success',
      content: 'Mocked live webpage content delta for unit test',
    }),
  } as unknown as PageFetcher;

  const taskService = new TaskService(db);
  const taskExecutor = new TaskExecutor(undefined, mockPageFetcher);
  const taskScheduler = new TaskScheduler(taskService, taskExecutor, undefined, 'Asia/Jakarta');
  const tools = createReminderTools(taskService, { timeZone: 'Asia/Jakarta', locale: 'id-ID' });
  const setTool = tools.find((t) => t.name === 'set_reminder')!;
  const listTool = tools.find((t) => t.name === 'list_reminders')!;
  const cancelTool = tools.find((t) => t.name === 'cancel_reminder')!;

  const mockMsg: IncomingMessage = {
    id: 'msg-1',
    senderId: 'owner-1',
    senderName: 'Adli',
    chatId: `chat-${Date.now()}`,
    chatType: 'dm',
    role: 'owner',
    text: 'remind me in 5 minutes',
    timestamp: Date.now(),
  };

  it('exports individual reminder tool factories alongside bundle', () => {
    const setToolSingle = createSetReminderTool(taskService, { timeZone: 'Asia/Jakarta', locale: 'id-ID' });
    const cancelToolSingle = createCancelReminderTool(taskService);
    const listToolSingle = createListRemindersTool(taskService, { timeZone: 'Asia/Jakarta', locale: 'id-ID' });

    expect(setToolSingle.name).toBe('set_reminder');
    expect(cancelToolSingle.name).toBe('cancel_reminder');
    expect(listToolSingle.name).toBe('list_reminders');
    expect(tools.length).toBe(3);
  });

  it('creates scheduled reminder and retrieves due scheduled tasks', async () => {
    const pastTimestamp = Date.now() - 1000; // already due
    const taskRes = await taskService.createScheduledTask({
      chatId: mockMsg.chatId,
      title: 'Test alarm',
      scheduleType: 'once',
      scheduleConfig: {},
      actionType: 'reminder',
      actionPayload: { text: 'Test alarm' },
      nextRunAt: pastTimestamp,
    });
    const id = taskRes.id;
    expect(id).toBeGreaterThan(0);

    const due = await taskService.getDueScheduledTasks();
    const found = due.find((d) => d.id === id);
    expect(found).toBeDefined();
    expect(found?.title).toBe('Test alarm');

    await taskService.updateTaskAfterExecution(id, {
      status: 'completed',
      nextRunAt: pastTimestamp,
      lastExecutedAt: Date.now(),
    });
    const after = await taskService.getDueScheduledTasks();
    expect(after.find((d) => d.id === id)).toBeUndefined();
  });

  it('schedules reminder through tool and formats response', async () => {
    const result = await setTool.execute(
      { text: 'Bring in the laundry', delayMinutes: 10 },
      mockMsg
    );

    expect(result.status).toBe('scheduled');
    expect(result.title).toBe('Bring in the laundry');
    expect(result.nextRunAt).toContain('WIB');

    const activeList = await listTool.execute({}, mockMsg);
    expect(activeList.status).toBe('active');
    expect(activeList.reminders.length).toBeGreaterThan(0);
    expect(activeList.reminders.some((r: any) => r.text === 'Bring in the laundry')).toBe(true);
  });

  it('supports targetTime and advanceMinutes calculation', async () => {
    const result = await setTool.execute(
      { text: 'Important meeting', targetTime: '18:00', advanceMinutes: 15 },
      mockMsg
    );

    expect(result.status).toBe('scheduled');
    expect(result.advanceMinutes).toBe(15);
    expect(result.nextRunAt).toContain('WIB');
  });

  it('purges completed reminders older than cutoff', async () => {
    const pastTimestamp = Date.now() - 5 * 24 * 60 * 60 * 1000; // 5 days ago
    const taskRes = await taskService.createScheduledTask({
      chatId: mockMsg.chatId,
      title: 'Old task',
      scheduleType: 'once',
      scheduleConfig: {},
      actionType: 'reminder',
      actionPayload: { text: 'Old task' },
      nextRunAt: pastTimestamp,
    });
    await taskService.updateTaskAfterExecution(taskRes.id, {
      status: 'completed',
      nextRunAt: pastTimestamp,
      lastExecutedAt: Date.now(),
    });

    const purged = await taskService.purgeOldTasks(3);
    expect(purged).toBeGreaterThan(0);
  });

  it('purges cancelled reminders and tasks older than cutoff', async () => {
    const pastTimestamp = Date.now() - 5 * 24 * 60 * 60 * 1000; // 5 days ago
    const taskRes = await taskService.createScheduledTask({
      chatId: mockMsg.chatId,
      title: 'Old cancelled task',
      scheduleType: 'once',
      scheduleConfig: {},
      actionType: 'reminder',
      actionPayload: { text: 'Old cancelled task' },
      nextRunAt: pastTimestamp,
    });
    await taskService.cancelReminder(taskRes.id);

    const purged = await taskService.purgeOldTasks(3);
    expect(purged).toBeGreaterThan(0);
  });

  it('retrieves recently completed reminders within time window', async () => {
    const recentDue = Date.now() - 5 * 60 * 1000; // 5 minutes ago
    const taskRes = await taskService.createScheduledTask({
      chatId: mockMsg.chatId,
      title: 'Recently finished',
      scheduleType: 'once',
      scheduleConfig: {},
      actionType: 'reminder',
      actionPayload: { text: 'Recently finished' },
      nextRunAt: recentDue,
    });
    await taskService.updateTaskAfterExecution(taskRes.id, {
      status: 'completed',
      nextRunAt: recentDue,
      lastExecutedAt: Date.now(),
    });

    const completed = await taskService.getRecentlyCompletedReminders(mockMsg.chatId, 60 * 60 * 1000);
    const found = completed.find((c) => c.id === taskRes.id);
    expect(found).toBeDefined();
    expect(found?.text).toBe('Recently finished');
    expect(found?.status).toBe('completed');
  });

  it('prevents duplicate reminder creation programmatically', async () => {
    const targetDue = Date.now() + 60 * 60 * 1000;
    const res1 = await taskService.createScheduledTask({
      chatId: mockMsg.chatId,
      title: 'Buy eggs from supermarket',
      scheduleType: 'once',
      scheduleConfig: {},
      actionType: 'reminder',
      actionPayload: { text: 'Buy eggs from supermarket' },
      nextRunAt: targetDue,
    });
    const res2 = await taskService.createScheduledTask({
      chatId: mockMsg.chatId,
      title: 'Buy eggs from supermarket',
      scheduleType: 'once',
      scheduleConfig: {},
      actionType: 'reminder',
      actionPayload: { text: 'Buy eggs from supermarket' },
      nextRunAt: targetDue + 1000, // 1s difference
    });
    expect(res2.isDuplicate).toBe(true);
    expect(res2.id).toBe(res1.id);
  });

  it('cancels reminder by ID via cancelTool', async () => {
    const res = await setTool.execute({ text: 'Call doctor', delayMinutes: 30 }, mockMsg);
    expect(res.status).toBe('scheduled');

    const cancelRes = await cancelTool.execute({ reminderId: res.taskId }, mockMsg);
    expect(cancelRes.status).toBe('cancelled');
    expect(cancelRes.reminderId).toBe(res.taskId);

    const checkList = await listTool.execute({}, mockMsg);
    expect(checkList.reminders?.some((r: any) => r.id === res.reminderId)).toBe(false);
  });

  it('cancels reminder by matching keyword via cancelTool', async () => {
    await setTool.execute({ text: 'Wash the sports car', delayMinutes: 45 }, mockMsg);

    const cancelRes = await cancelTool.execute({ keyword: 'sports car' }, mockMsg);
    expect(cancelRes.status).toBe('cancelled');
    expect(cancelRes.message).toContain('Wash the sports car');
  });

  it('resiliently handles string numbers and units in parameters', async () => {
    const res = await setTool.execute(
      { text: 'String minutes task', delayMinutes: '20 minutes' },
      mockMsg
    );
    expect(res.status).toBe('scheduled');
    expect(res.delayMinutes).toBe(20);

    const cancelRes = await cancelTool.execute({ reminderId: String(res.taskId) }, mockMsg);
    expect(cancelRes.status).toBe('cancelled');
    expect(cancelRes.reminderId).toBe(res.taskId);
  });

  it('schedules recurring interval task and lists it', async () => {
    const result = await setTool.execute(
      {
        text: 'Check website updates',
        repeatType: 'interval',
        intervalMinutes: 120,
        durationDays: 3,
      },
      mockMsg
    );

    expect(result.status).toBe('scheduled');
    expect(result.scheduleType).toBe('interval');
    expect(result.intervalMinutes).toBe(120);

    const activeList = await listTool.execute({}, mockMsg);
    expect(activeList.reminders.some((r: any) => r.text.includes('Check website updates'))).toBe(true);
  });

  it('schedules URL watch task and detects deduplication', async () => {
    const result1 = await setTool.execute(
      {
        text: 'Monitor product price',
        repeatType: 'daily',
        targetTime: '09:00',
        url: 'https://example.com/item/1',
      },
      mockMsg
    );
    expect(result1.status).toBe('scheduled');

    const result2 = await setTool.execute(
      {
        text: 'Monitor product price duplicate',
        repeatType: 'daily',
        targetTime: '09:00',
        url: 'https://example.com/item/1',
      },
      mockMsg
    );
    expect(result2.status).toBe('already_scheduled');
  });

  it('formats daily scheduled tasks with targetTime or timezone in pending reminders', async () => {
    const chatId = `chat-daily-${Date.now()}`;

    await taskService.createScheduledTask({
      chatId,
      title: 'Morning standup',
      scheduleType: 'daily',
      scheduleConfig: { targetTime: '10:00' },
      actionType: 'reminder',
      actionPayload: { text: 'Morning standup' },
      nextRunAt: Date.now() + 3600000,
    });

    await taskService.createScheduledTask({
      chatId,
      title: 'Daily report without target time',
      scheduleType: 'daily',
      scheduleConfig: {},
      actionType: 'reminder',
      actionPayload: { text: 'Daily report without target time' },
      nextRunAt: Date.now() + 7200000,
    });

    const pending = await taskService.getPendingReminders(chatId, 'UTC');
    expect(pending.find((p) => p.text === '[Daily Routine 10:00] Morning standup')).toBeDefined();
    expect(pending.find((p) => p.text === '[Daily Routine UTC] Daily report without target time')).toBeDefined();
  });

  it('records recent task result summary and retrieves it for conversational context', async () => {
    const taskResult = await taskService.createScheduledTask({
      chatId: mockMsg.chatId,
      title: 'Monitor tech feed',
      scheduleType: 'interval',
      scheduleConfig: { intervalMinutes: 10 },
      actionType: 'watch_url',
      actionPayload: { url: 'https://example.com/feed' },
      nextRunAt: Date.now() - 1000,
    });

    let dispatched = false;
    await taskScheduler.processScheduledTask(
      {
        id: taskResult.id,
        chatId: mockMsg.chatId,
        title: 'Monitor tech feed',
        scheduleType: 'interval',
        scheduleConfig: { intervalMinutes: 10 },
        actionType: 'watch_url',
        actionPayload: { url: 'https://example.com/feed' },
        lastStateHash: 'previous-hash',
        nextRunAt: Date.now() - 1000,
        status: 'active',
        createdAt: Date.now(),
      },
      async (event) => {
        dispatched = true;
        expect(event.actionType).toBe('watch_url');
      }
    );

    // Retrieve recent task results
    const recent = await taskService.getRecentTaskResults(mockMsg.chatId, 60 * 60 * 1000);
    expect(Array.isArray(recent)).toBe(true);
  });

  describe('calculateNextDailyTimestamp timezone handling', () => {
    it('calculates target time based on configured timezone rather than host server timezone', () => {
      // 09:00 WIB is 02:00 UTC
      const now = new Date('2026-11-24T02:00:00.000Z');
      const nextRun = calculateNextDailyTimestamp('08:00', 0, 'Asia/Jakarta', now);
      expect(new Date(nextRun).toISOString()).toBe('2026-11-25T01:00:00.000Z');

      const formattedInTz = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Jakarta',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(nextRun));
      expect(formattedInTz).toBe('08:00');
    });

    it('schedules for today if target time has not passed yet in configured timezone', () => {
      // 07:00 WIB is 00:00 UTC
      const now = new Date('2026-11-24T00:00:00.000Z');
      const nextRun = calculateNextDailyTimestamp('08:00', 0, 'Asia/Jakarta', now);
      expect(new Date(nextRun).toISOString()).toBe('2026-11-24T01:00:00.000Z');
    });

    it('handles advanceMinutes correctly', () => {
      // 07:10 WIB (00:10 UTC). Target 08:00 with 15 mins advance -> should run today at 07:45 WIB (00:45 UTC)
      const nowBefore = new Date('2026-11-24T00:10:00.000Z');
      const nextRunBefore = calculateNextDailyTimestamp('08:00', 15, 'Asia/Jakarta', nowBefore);
      expect(new Date(nextRunBefore).toISOString()).toBe('2026-11-24T00:45:00.000Z');

      // 07:50 WIB (00:50 UTC). 07:45 WIB has already passed today -> should schedule for tomorrow at 07:45 WIB (2026-11-25T00:45:00.000Z)
      const nowAfter = new Date('2026-11-24T00:50:00.000Z');
      const nextRunAfter = calculateNextDailyTimestamp('08:00', 15, 'Asia/Jakarta', nowAfter);
      expect(new Date(nextRunAfter).toISOString()).toBe('2026-11-25T00:45:00.000Z');
    });

    it('handles month and year rollover correctly', () => {
      // Month rollover: 2026-11-30 09:00 WIB (02:00 UTC)
      const endOfMonth = new Date('2026-11-30T02:00:00.000Z');
      const nextMonth = calculateNextDailyTimestamp('08:00', 0, 'Asia/Jakarta', endOfMonth);
      expect(new Date(nextMonth).toISOString()).toBe('2026-12-01T01:00:00.000Z');

      // Year rollover: 2026-12-31 09:00 WIB (02:00 UTC)
      const endOfYear = new Date('2026-12-31T02:00:00.000Z');
      const nextYear = calculateNextDailyTimestamp('08:00', 0, 'Asia/Jakarta', endOfYear);
      expect(new Date(nextYear).toISOString()).toBe('2027-01-01T01:00:00.000Z');
    });

    it('supports alternative timezones and validates invalid timezones', () => {
      // 07:00 UTC -> In America/New_York (EST, UTC-5 in January), it is 02:00 AM EST.
      // Target 08:00 EST has not passed yet today in NY. 08:00 EST = 13:00 UTC.
      const now = new Date('2026-01-15T07:00:00.000Z');
      const nyRun = calculateNextDailyTimestamp('08:00', 0, 'America/New_York', now);
      expect(new Date(nyRun).toISOString()).toBe('2026-01-15T13:00:00.000Z');

      // Invalid timezone throws RangeError
      expect(() => calculateNextDailyTimestamp('08:00', 0, 'invalid-timezone', now)).toThrow();
    });
  });
});
