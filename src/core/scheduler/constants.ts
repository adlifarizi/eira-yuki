/** Default polling interval for the background task scheduler in milliseconds. */
export const DEFAULT_TICK_INTERVAL_MS = 10_000;

/** Number of scheduler ticks between automatic old-task purge sweeps. */
export const PURGE_EVERY_N_TICKS = 60;

/** Number of days to retain completed or cancelled tasks before purging. */
export const TASK_RETENTION_DAYS = 3;

/** Maximum character length of fetched webpage content retained for watch-task diffs and alerts. */
export const MAX_WATCH_CONTENT_CHARS = 2500;
