import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { runtimeConfig } from '@/config/configuration';

const TRANSIENT = 'TransientTransactionError';
const UNKNOWN_COMMIT = 'UnknownTransactionCommitResult';
/** MaxTimeMSExpired: a commit that timed out on the server must not be retried (transactions spec). */
const MAX_TIME_MS_EXPIRED = 50;
const WRITE_CONFLICT = 112;
const QUIET_WRITE_CONFLICT_ATTEMPTS = 5;

const BACKOFF_BASE_MS = 10;
const BACKOFF_MAX_MS = 500;

const TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
} as const;

/** Delay before retry `attempt` (1-based): exponential from 10 ms, capped at 500 ms, with 50 % jitter. */
export function transactionBackoffMs(attempt: number, random: () => number = Math.random): number {
  const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.round(step / 2 + (random() * step) / 2);
}

const hasLabel = (error: unknown, label: string): boolean =>
  typeof (error as { hasErrorLabel?: unknown })?.hasErrorLabel === 'function' &&
  (error as { hasErrorLabel: (l: string) => boolean }).hasErrorLabel(label);

/**
 * Runs work inside a MongoDB transaction (replica set required) with bounded retries:
 * - `TransientTransactionError` (write conflict, failover, network error mid-transaction): the whole
 *   callback runs again in a new transaction;
 * - `UnknownTransactionCommitResult` (commit outcome unknown): the commit is retried (idempotent);
 * both with exponential, jittered backoff, at most `MONGO_TRANSACTION_MAX_ATTEMPTS` times and never
 * starting a retry after `MONGO_TRANSACTION_RETRY_WINDOW_MS` (the driver's own helper would retry
 * for up to 120 s, far beyond any request timeout). The last error is then thrown (503 envelope).
 *
 * The callback must be safe to run more than once and must pass `session` to every query.
 */
@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Inject(runtimeConfig.KEY) private readonly resilience: ConfigType<typeof runtimeConfig>,
  ) {}

  async run<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    for (let attempt = 1; ; attempt += 1) {
      const session = await this.connection.startSession();
      try {
        session.startTransaction(TRANSACTION_OPTIONS);
        let result: T;
        try {
          result = await work(session);
        } catch (err) {
          await this.abort(session);
          throw err;
        }
        await this.commit(session, startedAt);
        return result;
      } catch (err) {
        if (!hasLabel(err, TRANSIENT) || !(await this.backOff(attempt, startedAt, err, 'transaction'))) throw err;
      } finally {
        await session.endSession().catch(() => undefined);
      }
    }
  }

  private async commit(session: ClientSession, startedAt: number): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await session.commitTransaction();
        return;
      } catch (err) {
        const retryable = hasLabel(err, UNKNOWN_COMMIT) && (err as { code?: unknown }).code !== MAX_TIME_MS_EXPIRED;
        if (!retryable || !(await this.backOff(attempt, startedAt, err, 'commit'))) throw err;
      }
    }
  }

  /** Sleeps before the next attempt; false when the attempt or time budget is spent. */
  private async backOff(attempt: number, startedAt: number, err: unknown, what: string): Promise<boolean> {
    const { transactionMaxAttempts, transactionRetryWindowMs } = this.resilience.mongo;
    const delayMs = transactionBackoffMs(attempt);
    if (attempt >= transactionMaxAttempts || performance.now() - startedAt + delayMs > transactionRetryWindowMs) {
      return false;
    }
    const code = (err as { code?: unknown }).code;
    // Write conflicts between concurrent transactions are routine contention: quiet unless they persist.
    if (code === WRITE_CONFLICT && attempt < QUIET_WRITE_CONFLICT_ATTEMPTS) {
      this.logger.debug({ attempt, delayMs, code }, `Write conflict, retrying the ${what}`);
    } else {
      this.logger.warn({ err, attempt, delayMs, code }, `Transient MongoDB error, retrying the ${what}`);
    }
    await this.sleep(delayMs);
    return true;
  }

  private async abort(session: ClientSession): Promise<void> {
    if (!session.inTransaction()) return;
    // Best effort: the server also aborts an unfinished transaction after transactionLifetimeLimitSeconds.
    await session.abortTransaction().catch(() => undefined);
  }

  /** Separate for tests (fake timers). */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
