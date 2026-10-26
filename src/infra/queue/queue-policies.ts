import type { DefaultJobOptions, KeepJobs, RateLimiterOptions, WorkerOptions } from 'bullmq';
import { QueueName } from './queue.constants';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Retry backoff of every queue: exponential (delay · 2^(attempt−1)) with 50 % jitter, so jobs
 * failing together (a provider outage) do not come back together.
 */
const JITTER = 0.5;

/** Completed jobs: kept a day (dedupe window of deterministic jobIds), at most 1000 per queue. */
export const KEEP_COMPLETED: KeepJobs = { age: DAY / SECOND, count: 1_000 };
/** Failed jobs: kept a week for the ops "failed jobs" review, at most 5000 per queue (bounded Redis memory). */
export const KEEP_FAILED: KeepJobs = { age: (7 * DAY) / SECOND, count: 5_000 };

/** Worker defaults: a stalled job (worker died) goes back once, then fails (visible in ops). */
export const DEFAULT_LOCK_MS = 60 * SECOND;
export const DEFAULT_STALLED_INTERVAL_MS = 30 * SECOND;
export const DEFAULT_MAX_STALLED = 1;
/** Per-minute completed / failed counts kept by every worker (ops: "completed last 24 h"). */
export const METRICS_DATA_POINTS = 2 * 24 * 60;

export interface QueuePolicy {
  /** What the queue does. */
  purpose: string;
  /** Owning module (the one that registers producers and the processor). */
  owner: string;
  /** Default attempts (a producer may pass its own). */
  attempts: number;
  /** First retry delay; doubles per attempt, 50 % jitter. */
  backoffMs: number;
  /** Jobs processed at once per worker process. */
  concurrency: number;
  /** Queue-wide rate limit (all worker processes together), for providers with quotas. */
  limiter?: RateLimiterOptions;
  /** Lock duration (renewed while the job runs); a job whose lock expires is "stalled". */
  lockMs?: number;
  /** Times a stalled job is moved back to waiting before it fails. */
  maxStalledCount?: number;
  /** Why re-running a job (retry, stalled, duplicate) cannot repeat a side effect. */
  idempotency: string;
}

/**
 * The one table of BullMQ settings: job defaults (attempts, backoff, retention) are applied to
 * every queue at start (QueuePolicyApplier), worker settings (concurrency, limiter, stalled
 * handling, metrics) by PolicyWorker. This table is the only source of worker concurrency:
 * processors declare `@Processor(QueueName.X)` without options (PolicyWorker would override and
 * warn about a differing decorator value). Documented in docs/conventions/queues.md.
 */
export const QUEUE_POLICIES: Readonly<Record<QueueName, QueuePolicy>> = Object.freeze({
  [QueueName.OTP_DELIVERY]: {
    purpose: 'Deliver a one-time code by SMS or e-mail',
    owner: 'identity',
    // A code is only useful for a few minutes: retry quickly, then give up (the person can resend).
    attempts: 3,
    backoffMs: 2 * SECOND,
    concurrency: 10,
    // Provider quotas (Twilio account rate, SMTP relay): at most 20 sends a second across workers.
    limiter: { max: 20, duration: SECOND },
    idempotency: 'send-once claim per code (otp:<key>:<sends>); ambiguous sends are never repeated',
  },
  [QueueName.ACCOUNT_DELETION]: {
    purpose: 'Anonymise accounts whose deletion grace period is over',
    owner: 'identity',
    attempts: 5,
    backoffMs: 30 * SECOND,
    concurrency: 2,
    idempotency: 're-checks the deletion request; anonymising twice is a no-op',
  },
  [QueueName.NOTIFICATIONS]: {
    purpose: 'Push, inbox and e-mail deliveries requested through the Notifier (≤ 500 users per job)',
    owner: 'notifications',
    attempts: 3,
    backoffMs: 5 * SECOND,
    concurrency: 5,
    // FCM quota (600k messages / minute per project): ~500 messages per job.
    limiter: { max: 10, duration: SECOND },
    idempotency: 'deliveries claimed queued → sending once; never re-claimed or re-sent',
  },
  [QueueName.NOTES]: {
    purpose: 'Example module: note reminders and background work',
    owner: 'examples',
    attempts: 3,
    backoffMs: 5 * SECOND,
    concurrency: 5,
    idempotency: 'conditional claim on the note (reminderSentAt); Notifier dedupes per occurrence',
  },
  [QueueName.STRIPE_EVENTS]: {
    purpose: 'Handle Stripe webhook events outside the webhook request',
    owner: 'payments',
    // Stripe retries a webhook for days; ours retry for about 40 minutes, then show up in ops.
    attempts: 8,
    backoffMs: 10 * SECOND,
    concurrency: 2,
    idempotency: 'one job per Stripe event id; handlers are conditional (status transitions)',
  },
});

/** Policy of a queue (unknown names, e.g. test queues, get the defaults). */
export function policyFor(name: string): QueuePolicy {
  return (
    (QUEUE_POLICIES as Record<string, QueuePolicy>)[name] ?? {
      purpose: name,
      owner: 'unknown',
      attempts: 3,
      backoffMs: 5 * SECOND,
      concurrency: 1,
      idempotency: 'unknown',
    }
  );
}

/** Job defaults of a queue; a producer's own options still win per job. */
export function jobOptionsFor(name: string): DefaultJobOptions {
  const policy = policyFor(name);
  return {
    attempts: policy.attempts,
    backoff: { type: 'exponential', delay: policy.backoffMs, jitter: JITTER },
    removeOnComplete: KEEP_COMPLETED,
    removeOnFail: KEEP_FAILED,
  };
}

/** Worker settings of a queue (merged over whatever the processor decorator passed). */
export function workerOptionsFor(name: string): Partial<WorkerOptions> {
  const policy = policyFor(name);
  return {
    concurrency: policy.concurrency,
    ...(policy.limiter ? { limiter: policy.limiter } : {}),
    lockDuration: policy.lockMs ?? DEFAULT_LOCK_MS,
    stalledInterval: DEFAULT_STALLED_INTERVAL_MS,
    maxStalledCount: policy.maxStalledCount ?? DEFAULT_MAX_STALLED,
    metrics: { maxDataPoints: METRICS_DATA_POINTS },
  };
}
