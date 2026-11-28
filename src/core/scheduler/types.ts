export type ScheduleType = 'once' | 'interval' | 'daily';
export type ActionType = 'reminder' | 'watch_url';

export interface ScheduleConfig {
  targetTime?: string;
  intervalMinutes?: number;
  advanceMinutes?: number;
}

export interface ActionPayload {
  url?: string;
  text?: string;
  prompt?: string;
  renderJs?: boolean;
  [key: string]: unknown;
}

export interface ScheduledTaskItem {
  id: number;
  chatId: string;
  title: string;
  scheduleType: ScheduleType;
  scheduleConfig: ScheduleConfig;
  actionType: ActionType;
  actionPayload: ActionPayload;
  lastStateHash?: string | null;
  lastResultSummary?: string | null;
  lastExecutedAt?: number | null;
  nextRunAt: number;
  expiresAt?: number | null;
  status: 'active' | 'completed' | 'cancelled';
  createdAt: number;
}

export interface TaskDispatchEvent {
  id: number;
  chatId: string;
  actionType: ActionType;
  text: string;
  url?: string;
  previousSnippet?: string;
  diffSnippet?: string;
  dueTimestamp: number;
  status: string;
  createdAt: number;
}

export interface ReminderItem {
  id: number;
  chatId: string;
  text: string;
  dueTimestamp: number;
  status: string;
  createdAt: number;
}

export interface CreateScheduledTaskParams {
  chatId: string;
  title: string;
  scheduleType: ScheduleType;
  scheduleConfig: ScheduleConfig;
  actionType: ActionType;
  actionPayload: ActionPayload;
  nextRunAt: number;
  expiresAt?: number | null;
}

export interface TaskExecutionResult {
  dispatchEvent?: TaskDispatchEvent;
  newHash?: string;
  diffSummary?: string;
}

export interface RecentTaskResult {
  id: number;
  title: string;
  actionType: string;
  summary: string;
  executedAt: number;
  url?: string;
}

export interface TaskExecutionUpdate {
  status: 'active' | 'completed';
  nextRunAt?: number;
  lastStateHash?: string | null;
  lastResultSummary?: string | null;
  lastExecutedAt: number;
}
