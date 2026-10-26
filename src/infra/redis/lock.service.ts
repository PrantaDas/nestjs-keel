import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { redisConfig } from '@/config/configuration';
import { SystemErrors, SystemException } from '@/common/exceptions';
import { REDIS_CORE } from './redis.constants';

// Delete / extend only if we still own the lock (token matches).
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const EXTEND_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

export interface LockOptions {
  /**
   * Lock lifetime without renewal. A watchdog renews it every third of the TTL while the task
   * runs, so it bounds how long a crashed holder blocks others, not how long a task may run.
   */
  ttlMs: number;
  /** `skip` returns `{ acquired: false, reason: 'busy' }`; `throw` raises LOCK_NOT_ACQUIRED. */
  onBusy?: 'skip' | 'throw';
  /**
   * The core Redis cannot be reached to take the lock: `throw` (default) propagates the Redis error
   * (503 for a request, a retry for a job); `skip` returns `{ acquired: false, reason: 'unavailable' }`.
   * Either way the task never runs without the lock.
   */
  onUnavailable?: 'throw' | 'skip';
}

export type LockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; reason: 'busy' }
  | { acquired: false; reason: 'unavailable'; error: unknown };

/** Handed to the task. `signal` aborts when the lock is lost (renewal refused, or impossible past the TTL). */
export interface HeldLock {
  readonly signal: AbortSignal;
}

/**
 * Distributed mutex on the core Redis (single instance, SET NX PX + token-checked release).
 * Used to make cron ticks run once across instances and to serialise critical writes.
 */
@Injectable()
export class LockService {
  private readonly logger = new Logger(LockService.name);

  constructor(
    @Inject(REDIS_CORE) private readonly redis: Redis,
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
  ) {}

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(this.key(key), token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  }

  async release(key: string, token: string): Promise<boolean> {
    return (await this.redis.eval(RELEASE_SCRIPT, 1, this.key(key), token)) === 1;
  }

  async extend(key: string, token: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.eval(EXTEND_SCRIPT, 1, this.key(key), token, ttlMs)) === 1;
  }

  /**
   * Runs `task` while holding the lock; the lock is renewed until the task settles, then released.
   * If renewal is refused (the key expired or changed owner) or keeps failing for a whole TTL
   * (Redis unreachable), `lock.signal` aborts and an error is logged: another holder may start.
   * Tasks that run long should check `lock.signal.aborted` at safe points.
   */
  async withLock<T>(key: string, options: LockOptions, task: (lock: HeldLock) => Promise<T>): Promise<LockResult<T>> {
    let token: string | null;
    try {
      token = await this.acquire(key, options.ttlMs);
    } catch (error) {
      if (options.onUnavailable === 'skip') return { acquired: false, reason: 'unavailable', error };
      throw error;
    }
    if (!token) {
      if (options.onBusy === 'throw') throw new SystemException(SystemErrors.LOCK_NOT_ACQUIRED);
      return { acquired: false, reason: 'busy' };
    }

    const controller = new AbortController();
    let renewedAt = performance.now();
    const lose = (reason: string) => {
      if (controller.signal.aborted) return;
      clearInterval(watchdog);
      controller.abort(new Error(`Lock ${key} ${reason}`));
      this.logger.error({ key, reason }, 'Lock lost while its task was still running');
    };
    const watchdog = setInterval(
      () => {
        this.extend(key, token, options.ttlMs).then(
          (owned) => {
            if (owned) renewedAt = performance.now();
            else lose('was taken over or expired');
          },
          (err: unknown) => {
            this.logger.warn({ err, key }, 'Failed to extend lock');
            if (performance.now() - renewedAt >= options.ttlMs) lose('expired: Redis unreachable for its whole TTL');
          },
        );
      },
      // Renew well before expiry: at a third of the ttl, never slower.
      Math.max(50, Math.floor(options.ttlMs / 3)),
    );
    watchdog.unref();

    try {
      return { acquired: true, value: await task({ signal: controller.signal }) };
    } finally {
      clearInterval(watchdog);
      await this.release(key, token).catch((err: unknown) => this.logger.warn({ err, key }, 'Failed to release lock'));
    }
  }

  private key(key: string): string {
    return `${this.config.keyPrefix}lock:${key}`;
  }
}
