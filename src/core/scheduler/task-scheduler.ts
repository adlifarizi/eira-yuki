import { Logger } from 'pino';
import { ScheduledTaskItem, TaskDispatchEvent } from './types';
import { TaskService } from './task-service';
import { TaskExecutor } from './task-executor';
import { resolveTimeZone, calculateNextRunTimestamp } from './time-calculator';
import { DEFAULT_TICK_INTERVAL_MS, PURGE_EVERY_N_TICKS, TASK_RETENTION_DAYS } from './constants';

/**
 * Background daemon that polls due scheduled tasks, executes them with concurrency locking,
 * and periodically purges expired task records.
 */
export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null;
  private processingTaskIds = new Set<number>();
  private timeZone: string;

  constructor(
    public readonly taskService: TaskService,
    public readonly taskExecutor: TaskExecutor,
    private logger: Logger | undefined,
    timeZone: string
  ) {
    this.timeZone = resolveTimeZone(timeZone);
  }

  async processScheduledTask(
    task: ScheduledTaskItem,
    onTrigger: (event: TaskDispatchEvent) => Promise<void>
  ): Promise<void> {
    const now = Date.now();
    const executionResult = await this.taskExecutor.execute(task);
    const finalHash = executionResult.newHash !== undefined ? executionResult.newHash : task.lastStateHash;
    const diffSummary = executionResult.diffSummary || task.lastResultSummary;

    if (task.scheduleType === 'once') {
      await this.taskService.updateTaskAfterExecution(task.id, {
        status: 'completed',
        lastStateHash: finalHash,
        lastResultSummary: diffSummary,
        lastExecutedAt: now,
      });
    } else {
      const nextRun = calculateNextRunTimestamp(
        task.scheduleType,
        task.scheduleConfig,
        this.timeZone,
        now
      );
      const isExpired = task.expiresAt ? nextRun > task.expiresAt : false;
      await this.taskService.updateTaskAfterExecution(task.id, {
        status: isExpired ? 'completed' : 'active',
        nextRunAt: nextRun,
        lastStateHash: finalHash,
        lastResultSummary: diffSummary,
        lastExecutedAt: now,
      });
    }

    if (executionResult.dispatchEvent) {
      await onTrigger(executionResult.dispatchEvent);
    }
  }

  /**
   * Starts the background polling loop to dispatch due tasks and purge expired records.
   */
  startScheduler(
    onTrigger: (event: TaskDispatchEvent) => Promise<void>,
    intervalMs: number = DEFAULT_TICK_INTERVAL_MS
  ): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    let tickCount = 0;
    this.timer = setInterval(async () => {
      try {
        tickCount++;
        if (tickCount % PURGE_EVERY_N_TICKS === 0) {
          await this.taskService.purgeOldTasks(TASK_RETENTION_DAYS);
        }

        const dueTasks = await this.taskService.getDueScheduledTasks();
        await Promise.allSettled(
          dueTasks
            .filter((task) => !this.processingTaskIds.has(task.id))
            .map(async (task) => {
              this.processingTaskIds.add(task.id);
              try {
                await this.processScheduledTask(task, onTrigger);
              } catch (taskErr) {
                this.logger?.error(taskErr, `Failed to process scheduled task ${task.id}`);
              } finally {
                this.processingTaskIds.delete(task.id);
              }
            })
        );
      } catch (err) {
        this.logger?.error(err, 'Error in reminder scheduler tick');
      }
    }, intervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stops the background polling loop if currently active.
   */
  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
