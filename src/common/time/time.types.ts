/**
 * Calendar day `YYYY-MM-DD`. Always computed by the time module for an explicit zone and
 * stored on day-scoped records at write time (never recomputed from an instant later).
 */
export type DayKey = string & { readonly __brand: 'DayKey' };

/** Validated, canonical IANA timezone name (`Europe/London`). Never a fixed offset. */
export type TimeZone = string & { readonly __brand: 'TimeZone' };

/** Wall-clock `HH:mm` (24h). */
export type LocalTime = string & { readonly __brand: 'LocalTime' };

export type WeekStart = 'sunday' | 'monday';

/** A wall-clock moment as a person enters it: "20:00 on 12 Oct in Dubai". */
export interface LocalDateTime {
  date: DayKey;
  time: LocalTime;
  timeZone: TimeZone;
}

/** Half-open interval: `start <= t < end`. Never use 23:59:59.999 end markers. */
export interface TimeRange {
  start: Date;
  end: Date;
}

export interface DayWindow extends TimeRange {
  day: DayKey;
}

export interface WeekWindow extends TimeRange {
  /** First day of the week. */
  startDay: DayKey;
}

export interface MonthWindow extends TimeRange {
  /** `YYYY-MM`. */
  month: string;
}

export const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
