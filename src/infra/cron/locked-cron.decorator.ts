import { applyDecorators, Inject, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import type { TimeZone } from '@/common/time/time.types';
import { normalizeTimeZone } from '@/common/time/zoned-time';
import { scheduleBusinessTimeZone } from '@/config/schedule-zone';
import { RateGate } from '@/common/utils/rate-gate';
import { LockService } from '@/infra/redis/lock.service';
import { CronRuns } from './cron-runs';

const LOCK_SERVICE = Symbol('lockedCron:lockService');
const CRON_RUNS = Symbol('lockedCron:runs');

/**
 * Upper bound of the lock TTL. The watchdog renews the lock while a run is in progress, so the TTL
 * only decides how soon a crashed run (process killed, OOM) stops blocking: capped so the next
 * tick of a every-minute cron already runs again.
 */
export const CRON_LOCK_MAX_TTL_MS = 30_000;

/** "Skipped: Redis down" is logged at most once a minute per cron during an outage. */
const unavailableLogs = new RateGate(60_000);

export interface LockedCronOptions {
  /** Unique job name; also the lock key and the log label. */
  name: string;
  /**
   * Crash-recovery window: how long the lock of a run whose process died keeps blocking other
   * ticks. Renewed while the run is alive (runs may last longer). Capped at 30 s, default 30 s.
   */
  lockTtlMs?: number;
  /**
   * Required: the zone the expression is read in, never the server's. `'business'` is the
   * configured `BUSINESS_TIMEZONE` ("every day at 02:00 business time"); `'UTC'` for intervals.
   */
  timeZone: TimeZone | 'business' | 'UTC';
}

/** The IANA zone of a cron, resolved when the class is defined; a missing or invalid one stops the boot. */
export function resolveCronTimeZone(name: string, zone: LockedCronOptions['timeZone'] | undefined): TimeZone {
  const resolved = zone === 'business' ? scheduleBusinessTimeZone() : normalizeTimeZone(zone);
  if (!resolved) {
    throw new Error(
      `[cron] "${name}" must declare a valid IANA timeZone ('business', 'UTC' or e.g. 'Europe/London'), got ${String(zone)}`,
    );
  }
  return resolved;
}

type CronHost = Record<symbol, unknown>;

/**
 * `@Cron` that runs at most once per tick across all instances (Redis lock), with start /
 * finish / skip logs and Sentry reporting. Heavy work should be enqueued for the worker.
 *
 * Guarantees (docs/architecture/fault-tolerance.md):
 * - never two runs of the same cron at once: Redis lock across instances, plus an in-process
 *   guard that holds even if the lock was lost;
 * - core Redis unreachable: the tick is skipped and logged (the lock cannot be taken), never run
 *   unlocked;
 * - a crashed run blocks at most `lockTtlMs` (≤ 30 s), so the next tick recovers;
 * - shutdown: no new run starts, runs in progress may finish and release their lock;
 * - a failing run is logged and reported, never crashes the process.
 *
 * @example
 * @LockedCron('0 2 * * *', { name: 'notes-purge-deleted', timeZone: 'business' })
 * async purge() { ... }
 */
export function LockedCron(expression: string, options: LockedCronOptions): MethodDecorator {
  const logger = new Logger(`Cron:${options.name}`);
  const timeZone = resolveCronTimeZone(options.name, options.timeZone);
  const ttlMs = Math.min(options.lockTtlMs ?? CRON_LOCK_MAX_TTL_MS, CRON_LOCK_MAX_TTL_MS);

  const wrap: MethodDecorator = (target, _key, descriptor: PropertyDescriptor) => {
    Inject(LockService)(target, LOCK_SERVICE);
    Optional()(target, CRON_RUNS);
    Inject(CronRuns)(target, CRON_RUNS);
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;

    descriptor.value = async function (this: CronHost, ...args: unknown[]) {
      const locks = this[LOCK_SERVICE] as LockService;
      const runs = this[CRON_RUNS] as CronRuns | undefined;

      const runLocked = async (): Promise<void> => {
        const startedAt = performance.now();
        const durationMs = () => Math.round(performance.now() - startedAt);
        try {
          const result = await locks.withLock(`cron:${options.name}`, { ttlMs, onUnavailable: 'skip' }, () =>
            original.apply(this, args),
          );
          if (result.acquired) {
            unavailableLogs.reset(options.name);
            logger.log({ durationMs: durationMs() }, 'Cron run completed');
          } else if (result.reason === 'unavailable') {
            const gate = unavailableLogs.pass(options.name);
            if (gate.pass) {
              logger.warn(
                { err: result.error, skippedSinceLastLog: gate.suppressed },
                'Cron run skipped: core Redis unreachable, the lock cannot be taken',
              );
            }
          } else {
            logger.debug('Cron run skipped: another instance holds the lock');
          }
        } catch (err) {
          logger.error({ err, durationMs: durationMs() }, 'Cron run failed');
          Sentry.withScope((scope) => {
            scope.setTag('cron', options.name);
            Sentry.captureException(err);
          });
        }
      };

      if (!runs) return runLocked();
      const outcome = await runs.run(options.name, runLocked);
      if (outcome === 'overlap') logger.warn('Cron run skipped: the previous run in this process is still going');
    };
    return descriptor;
  };

  return applyDecorators(Cron(expression, { name: options.name, timeZone }), wrap);
}
