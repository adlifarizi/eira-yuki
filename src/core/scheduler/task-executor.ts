import { createHash } from 'node:crypto';
import { Logger } from 'pino';
import { PageFetcher } from '../browser/page-fetcher';
import { ScheduledTaskItem, TaskExecutionResult } from './types';
import { MAX_WATCH_CONTENT_CHARS } from './constants';

export class TaskExecutor {
  constructor(
    private logger: Logger | undefined,
    private pageFetcher: PageFetcher
  ) {}

  async execute(task: ScheduledTaskItem): Promise<TaskExecutionResult> {
    if (task.actionType === 'reminder') {
      return {
        dispatchEvent: {
          id: task.id,
          chatId: task.chatId,
          actionType: 'reminder',
          text: task.title,
          dueTimestamp: task.nextRunAt,
          status: 'active',
          createdAt: task.createdAt,
        },
      };
    }

    if (task.actionType === 'watch_url') {
      const url = task.actionPayload.url;
      if (!url) {
        return {};
      }

      try {
        const fetchRes = await this.pageFetcher.fetch(url);

        if (fetchRes.status !== 'success' || !fetchRes.content) {
          return { newHash: task.lastStateHash ?? undefined };
        }

        const currentHash = createHash('sha256').update(fetchRes.content).digest('hex');

        if (!task.lastStateHash) {
          return { newHash: currentHash };
        }

        if (task.lastStateHash !== currentHash) {
          const diffSummary = fetchRes.content.slice(0, MAX_WATCH_CONTENT_CHARS);
          return {
            newHash: currentHash,
            diffSummary,
            dispatchEvent: {
              id: task.id,
              chatId: task.chatId,
              actionType: 'watch_url',
              text: `Change detected on URL: ${url}\n\nSummary:\n${diffSummary}`,
              url,
              diffSnippet: diffSummary,
              dueTimestamp: task.nextRunAt,
              status: 'active',
              createdAt: task.createdAt,
            },
          };
        }

        return { newHash: currentHash };
      } catch (err: any) {
        this.logger?.error({ err, url }, '[TaskExecutor] Error executing watch_url');
        return {};
      }
    }

    return {};
  }
}
