import { timeZone } from '@/common/time/zoned-time';
import type { TimeZone } from '@/common/time/time.types';

/**
 * The business zone for cron expressions. Cron decorators are evaluated when classes are defined,
 * before the config module exists, so this reads the (already loaded, see `load-env.ts`) variable
 * directly; the env schema validates the same value at boot.
 */
export function scheduleBusinessTimeZone(): TimeZone {
  return timeZone(process.env.BUSINESS_TIMEZONE || 'UTC');
}
