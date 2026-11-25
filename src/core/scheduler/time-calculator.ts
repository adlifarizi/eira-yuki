import { ScheduleConfig, ScheduleType } from './types';

/**
 * Invariant BCP 47 locale tag enforcing the Latin numeric numbering system (`nu-latn`).
 *
 * This locale is intentionally hardcoded for internal date-part mathematical calculations
 * rather than user-facing localized text formatting. It guarantees that `Intl.DateTimeFormat`
 * outputs deterministic ASCII digits (0-9) that can be safely parsed by `parseInt(..., 10)`,
 * preventing runtime `NaN` failures if the application or host environment defaults to a
 * non-Latin numbering system (e.g. Arabic, Bengali, or Devanagari numerals).
 */
const INVARIANT_ASCII_LOCALE = 'en-US-u-nu-latn';

/**
 * Internal cache of compiled `Intl.DateTimeFormat` instances keyed by IANA time zone identifier.
 * Reusing formatters eliminates the overhead of repeatedly instantiating ICU C++ formatters
 * during background scheduler evaluations.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Retrieves or creates a cached `Intl.DateTimeFormat` instance for extracting zoned calendar parts.
 *
 * @param timeZone - Validated IANA time zone identifier.
 * @returns Cached formatter configured with the invariant Latin numbering system.
 */
function getZonedPartsFormatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = formatterCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat(INVARIANT_ASCII_LOCALE, {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, dtf);
  }
  return dtf;
}

/**
 * Validates and returns a valid IANA time zone identifier.
 * Throws RangeError if the provided time zone is invalid.
 *
 * @param tz - IANA time zone string to validate.
 * @returns The validated time zone string.
 */
export function resolveTimeZone(tz: string): string {
  Intl.DateTimeFormat(undefined, { timeZone: tz });
  return tz;
}

/**
 * Converts calendar date and time parts specified in a target time zone into an absolute UTC epoch timestamp.
 *
 * @param year - Full calendar year (e.g. 2026).
 * @param month - Calendar month index (1-12).
 * @param day - Calendar day of the month (1-31).
 * @param hour - 24-hour clock hour (0-23).
 * @param minute - Clock minute (0-59).
 * @param second - Clock second (0-59).
 * @param timeZone - IANA time zone identifier.
 * @returns UTC epoch timestamp in milliseconds.
 */
export function getZonedTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): number {
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const dtf = getZonedPartsFormatter(timeZone);

  const getOffset = (d: Date): number => {
    const p = Object.fromEntries(dtf.formatToParts(d).map((x) => [x.type, x.value]));
    const inZone = Date.UTC(
      parseInt(p.year, 10),
      parseInt(p.month, 10) - 1,
      parseInt(p.day, 10),
      parseInt(p.hour, 10),
      parseInt(p.minute, 10),
      parseInt(p.second, 10)
    );
    return inZone - d.getTime();
  };

  const offset = getOffset(utcDate);
  let res = new Date(utcDate.getTime() - offset);
  const offset2 = getOffset(res);
  if (offset2 !== offset) {
    res = new Date(utcDate.getTime() - offset2);
  }
  return res.getTime();
}

/**
 * Calculates the exact next UTC epoch timestamp for a daily recurring schedule.
 *
 * @param targetTime - Desired time in HH:mm 24-hour format (e.g. "08:00").
 * @param advanceMinutes - Lead time before the target time to dispatch the notification.
 * @param timeZone - Target IANA time zone.
 * @param now - Reference point in time, defaults to current time.
 * @returns Next scheduled epoch timestamp in milliseconds.
 */
export function calculateNextDailyTimestamp(
  targetTime: string,
  advanceMinutes: number = 0,
  timeZone: string,
  now: Date = new Date()
): number {
  const safeTz = resolveTimeZone(timeZone);
  const parts = targetTime.trim().split(':');
  const targetHour = parseInt(parts[0], 10);
  const targetMin = parseInt(parts[1] || '0', 10);
  const safeHour = Number.isFinite(targetHour) ? Math.min(23, Math.max(0, targetHour)) : 8;
  const safeMin = Number.isFinite(targetMin) ? Math.min(59, Math.max(0, targetMin)) : 0;
  const safeAdvance = Math.max(0, advanceMinutes);

  const dtf = getZonedPartsFormatter(safeTz);
  const p = Object.fromEntries(dtf.formatToParts(now).map((x) => [x.type, x.value]));
  const year = parseInt(p.year, 10);
  const month = parseInt(p.month, 10);
  const day = parseInt(p.day, 10);

  let targetTimestamp = getZonedTimestamp(year, month, day, safeHour, safeMin, 0, safeTz);

  if (targetTimestamp - safeAdvance * 60 * 1000 <= now.getTime()) {
    targetTimestamp = getZonedTimestamp(year, month, day + 1, safeHour, safeMin, 0, safeTz);
  }

  return targetTimestamp - safeAdvance * 60 * 1000;
}

/**
 * Calculates the next execution timestamp based on schedule type and parameters.
 *
 * @param scheduleType - Type of schedule: 'daily', 'interval', or 'once'.
 * @param scheduleConfig - Parameters including targetTime or intervalMinutes.
 * @param timeZone - Target IANA time zone.
 * @param now - Reference epoch timestamp in milliseconds.
 * @returns Next scheduled epoch timestamp in milliseconds.
 */
export function calculateNextRunTimestamp(
  scheduleType: ScheduleType,
  scheduleConfig: ScheduleConfig,
  timeZone: string,
  now: number = Date.now()
): number {
  if (scheduleType === 'daily') {
    return calculateNextDailyTimestamp(
      scheduleConfig.targetTime || '08:00',
      scheduleConfig.advanceMinutes || 0,
      timeZone,
      new Date(now)
    );
  }

  if (scheduleType === 'interval') {
    const intervalMinutes = scheduleConfig.intervalMinutes || 60;
    return now + intervalMinutes * 60 * 1000;
  }

  return now + 24 * 60 * 60 * 1000;
}
