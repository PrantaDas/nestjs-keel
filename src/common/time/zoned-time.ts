import { DateTime, IANAZone } from 'luxon';
import {
  DAY_KEY_PATTERN,
  type DayKey,
  type DayWindow,
  LOCAL_TIME_PATTERN,
  type LocalDateTime,
  type LocalTime,
  type MonthWindow,
  type TimeZone,
  type WeekStart,
  type WeekWindow,
} from './time.types';

/*
 * The only place in the codebase that does timezone math (ESLint blocks it everywhere else).
 * Pure functions: explicit instant + explicit zone in, value out. No server-zone dependence.
 */

// Offset-style values ("+05:30", "UTC+05:30", "GMT-4") ignore daylight saving: rejected.
const OFFSET_LIKE = /^(?:UTC|GMT)?\s*[+-]\d/i;
const INSTANT_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Validated IANA name (trimmed, otherwise exactly as given), or null when not a real timezone.
 * Deliberately NOT "canonicalised" through Intl: Node's ICU rewrites Asia/Kolkata to the legacy
 * alias Asia/Calcutta, which would no longer match what apps send. Aliases compute identically.
 */
export function normalizeTimeZone(value: unknown): TimeZone | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || OFFSET_LIKE.test(candidate) || !IANAZone.isValidZone(candidate)) return null;
  return candidate as TimeZone;
}

export function isTimeZone(value: unknown): value is TimeZone {
  return normalizeTimeZone(value) !== null;
}

/** For constants: fails at module load on a typo instead of silently using a wrong zone. */
export function timeZone(value: string): TimeZone {
  const zone = normalizeTimeZone(value);
  if (!zone) throw new Error(`[time] "${value}" is not a valid IANA timezone`);
  return zone;
}

export function isDayKey(value: unknown): value is DayKey {
  return typeof value === 'string' && DAY_KEY_PATTERN.test(value) && DateTime.fromISO(value).isValid;
}

export function isLocalTime(value: unknown): value is LocalTime {
  return typeof value === 'string' && LOCAL_TIME_PATTERN.test(value);
}

/** Parses ISO-8601 with an explicit `Z` or `±HH:MM`; strings without an offset are rejected. */
export function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !INSTANT_WITH_OFFSET.test(value)) return null;
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed.toJSDate() : null;
}

/** The calendar day an instant falls on in `zone`. */
export function dayKeyOf(instant: Date, zone: TimeZone): DayKey {
  return DateTime.fromJSDate(instant, { zone }).toISODate() as DayKey;
}

/** `[start, end)` of a calendar day in `zone`. 23 or 25 hours long on daylight-saving days. */
export function dayWindow(day: DayKey, zone: TimeZone): DayWindow {
  const start = startOfDay(day, zone);
  return { day, start: start.toJSDate(), end: start.plus({ days: 1 }).startOf('day').toJSDate() };
}

export function dayWindowAt(instant: Date, zone: TimeZone): DayWindow {
  return dayWindow(dayKeyOf(instant, zone), zone);
}

export function addDays(day: DayKey, days: number): DayKey {
  return DateTime.fromISO(day, { zone: 'UTC' }).plus({ days }).toISODate() as DayKey;
}

/** Whole calendar days from `from` to `to` (positive when `to` is later). */
export function diffDays(from: DayKey, to: DayKey): number {
  return Math.round(DateTime.fromISO(to, { zone: 'UTC' }).diff(DateTime.fromISO(from, { zone: 'UTC' }), 'days').days);
}

export function weekWindowAt(instant: Date, zone: TimeZone, weekStartsOn: WeekStart): WeekWindow {
  const day = DateTime.fromJSDate(instant, { zone });
  // Luxon weekday: 1 = Monday … 7 = Sunday.
  const back = weekStartsOn === 'sunday' ? day.weekday % 7 : day.weekday - 1;
  const startDay = day.minus({ days: back }).toISODate() as DayKey;
  const start = startOfDay(startDay, zone);
  return { startDay, start: start.toJSDate(), end: start.plus({ weeks: 1 }).startOf('day').toJSDate() };
}

export function monthWindowAt(instant: Date, zone: TimeZone): MonthWindow {
  const start = DateTime.fromJSDate(instant, { zone }).startOf('month');
  return { month: start.toFormat('yyyy-MM'), start: start.toJSDate(), end: start.plus({ months: 1 }).toJSDate() };
}

/**
 * Wall-clock → instant. Returns null for a time that does not exist in that zone (skipped by a
 * daylight-saving jump). An ambiguous time (repeated hour) resolves to its first occurrence.
 */
export function localToInstant(local: LocalDateTime): Date | null {
  const parsed = DateTime.fromISO(`${local.date}T${local.time}`, { zone: local.timeZone });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm") !== `${local.date}T${local.time}`) return null;
  return parsed.toJSDate();
}

export function instantToLocal(instant: Date, zone: TimeZone): LocalDateTime {
  const local = DateTime.fromJSDate(instant, { zone });
  return { date: local.toISODate() as DayKey, time: local.toFormat('HH:mm') as LocalTime, timeZone: zone };
}

function startOfDay(day: DayKey, zone: TimeZone): DateTime {
  // startOf('day') also covers zones whose midnight is skipped on a DST change.
  return DateTime.fromISO(day, { zone }).startOf('day');
}
