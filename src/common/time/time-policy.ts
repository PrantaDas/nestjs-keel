import type { TimeZone, WeekStart } from './time.types';
import { timeZone } from './zoned-time';

/**
 * THE time rules of the app. Every feature asks `TimeService`, which reads only this object, so a
 * product decision ("our days start in Dubai", "weeks start on Sunday") is one config change.
 */
export interface TimePolicy {
  /** The zone a record's business day (`DayKey`), week and month are computed in (`BUSINESS_TIMEZONE`). */
  businessTimeZone: TimeZone;
  /** First day of a business week (`WEEK_STARTS_ON`). */
  weekStartsOn: WeekStart;
}

export const TIME_POLICY_TOKEN = Symbol('TIME_POLICY');

/** Builds the policy from config; a mistyped zone fails at boot (the env schema checks it too). */
export function timePolicy(config: { businessTimeZone: string; weekStartsOn: WeekStart }): TimePolicy {
  return Object.freeze({ businessTimeZone: timeZone(config.businessTimeZone), weekStartsOn: config.weekStartsOn });
}

/** Default for unit tests that do not care about the business zone. */
export const UTC_POLICY: TimePolicy = timePolicy({ businessTimeZone: 'UTC', weekStartsOn: 'monday' });
