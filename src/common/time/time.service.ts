import { Inject, Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { Clock } from './clock';
import { TIME_POLICY_TOKEN, type TimePolicy } from './time-policy';
import type { DayKey, DayWindow, LocalDateTime, MonthWindow, TimeZone, WeekWindow } from './time.types';
import {
  addDays,
  dayKeyOf,
  dayWindow,
  instantToLocal,
  localToInstant,
  monthWindowAt,
  normalizeTimeZone,
  weekWindowAt,
} from './zoned-time';

/**
 * Policy-aware time API for features. Features never pick a zone themselves: they ask for the
 * business day, week or month, and store the returned `DayKey` on the record they write, next to
 * the instant. The day is computed once, at write time, and never recomputed from a timestamp.
 */
@Injectable()
export class TimeService {
  constructor(
    private readonly clock: Clock,
    @Inject(TIME_POLICY_TOKEN) readonly policy: TimePolicy,
  ) {}

  now(): Date {
    return this.clock.now();
  }

  /** Whole seconds since the epoch (JWT `iat` / `exp`). */
  epochSeconds(at: Date = this.now()): number {
    return Math.floor(at.getTime() / 1000);
  }

  /** `now + ms` without touching `Date.now()`. */
  after(ms: number, from: Date = this.now()): Date {
    return new Date(from.getTime() + ms);
  }

  // ── Business calendar (the day a record belongs to, resets, reports) ─────

  get businessZone(): TimeZone {
    return this.policy.businessTimeZone;
  }

  /** The business day an instant belongs to (default: now). Store it on day-scoped records. */
  businessDay(at: Date = this.now()): DayKey {
    return dayKeyOf(at, this.policy.businessTimeZone);
  }

  /** Exact `[start, end)` of a business day; return `end` to clients for countdowns. */
  businessDayWindow(day: DayKey = this.businessDay()): DayWindow {
    return dayWindow(day, this.policy.businessTimeZone);
  }

  businessWeek(at: Date = this.now()): WeekWindow {
    return weekWindowAt(at, this.policy.businessTimeZone, this.policy.weekStartsOn);
  }

  businessMonth(at: Date = this.now()): MonthWindow {
    return monthWindowAt(at, this.policy.businessTimeZone);
  }

  /** Report filters: an inclusive day range in an explicit zone (default business zone) as `[start, end)`. */
  dayRange(from: DayKey, to: DayKey, zone: TimeZone = this.policy.businessTimeZone): { start: Date; end: Date } {
    return { start: dayWindow(from, zone).start, end: dayWindow(to, zone).end };
  }

  addDays(day: DayKey, days: number): DayKey {
    return addDays(day, days);
  }

  // ── User zone (display only: never decides which day a record belongs to) ─

  /**
   * Best known zone for the current user: device header (`X-Timezone`) → stored profile value →
   * business zone. Invalid values are ignored, never fatal.
   */
  userZone(stored?: string | null): TimeZone {
    return RequestContext.timeZone() ?? normalizeTimeZone(stored) ?? this.policy.businessTimeZone;
  }

  // ── Wall-clock input (a person picks "14 Oct, 20:00 in Asia/Dubai") ─────

  /** DTOs validate existence first (`LocalDateTimeDto`), so this only throws on unvalidated input. */
  toInstant(local: LocalDateTime): Date {
    const instant = localToInstant(local);
    if (!instant) throw new Error(`[time] ${local.date} ${local.time} does not exist in ${local.timeZone}`);
    return instant;
  }

  toLocal(instant: Date, zone: TimeZone): LocalDateTime {
    return instantToLocal(instant, zone);
  }
}
