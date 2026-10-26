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
  [QueueName.REWARD_PERIOD_SNAPSHOTS]: {
    purpose: 'Snapshot a closing leaderboard period',
    owner: 'rewards',
    attempts: 5,
    backoffMs: 10 * SECOND,
    concurrency: 1,
    lockMs: 2 * MINUTE,
    idempotency: 'resumable cursor + upserts; jobId per close attempt',
  },
  [QueueName.STORAGE_CLEANUP]: {
    purpose: 'Delete S3 objects (avatars, rejected uploads, replaced images)',
    owner: 'platform',
    attempts: 5,
    backoffMs: 30 * SECOND,
    concurrency: 2,
    idempotency: 'deleting a missing object is a no-op',
  },
  [QueueName.REPORT_JOBS]: {
    purpose: 'Generate xlsx exports to S3 and email the signed link',
    owner: 'platform',
    attempts: 3,
    backoffMs: 30 * SECOND,
    concurrency: 2,
    lockMs: 2 * MINUTE,
    idempotency: 'conditional state changes; email claimed once (send-once key)',
  },
  [QueueName.FILE_PURGE]: {
    purpose: 'Purge a file-manager subtree (S3 objects, then rows)',
    owner: 'platform',
    attempts: 5,
    backoffMs: 30 * SECOND,
    concurrency: 1,
    idempotency: 'deleting a missing object / row is a no-op',
  },
  [QueueName.USERS]: {
    purpose: 'Anonymise accounts after the deletion grace period',
    owner: 'identity',
    attempts: 5,
    backoffMs: 30 * SECOND,
    concurrency: 5,
    idempotency: 're-checks the deletion request; anonymising twice is a no-op',
  },
  [QueueName.DAILY_WORD_REMINDERS]: {
    purpose: 'Dispatch due daily-word reminders through the Notifier (one run per minute)',
    owner: 'daily-words',
    attempts: 2,
    backoffMs: 5 * SECOND,
    concurrency: 1,
    idempotency: 'Redis lock per run; Notifier dedupes (source, occurrenceKey, user)',
  },
  [QueueName.LIVE_QUIZ]: {
    purpose: 'Finalize an ended live-quiz session (ranks, report, Redis cleanup)',
    owner: 'live-quiz',
    attempts: 5,
    backoffMs: 5 * SECOND,
    concurrency: 2,
    idempotency: 'finalize is conditional on the session state',
  },
  [QueueName.CAMPAIGNS]: {
    purpose: 'Campaign runs (audience paging), send batches (FCM), live-quiz event fan-in',
    owner: 'notifications',
    attempts: 3,
    backoffMs: 5 * SECOND,
    concurrency: 5,
    // FCM quota (600k msgs/min per project): ~500 messages per batch job.
    limiter: { max: 10, duration: SECOND },
    idempotency: 'deliveries claimed queued → sending once; never re-claimed or re-sent',
  },
  [QueueName.NOTIFICATION_DELIVERIES]: {
    purpose: 'Direct pushes requested through the Notifier port (≤ 500 users per job)',
    owner: 'notifications',
    attempts: 2,
    backoffMs: 5 * SECOND,
    concurrency: 5,
    limiter: { max: 10, duration: SECOND },
    idempotency: 'deliveries claimed queued → sending once; never re-claimed or re-sent',
  },
  [QueueName.QUICK_NOTIFICATIONS]: {
    purpose: 'Quick (FCM topic) notifications and their inbox fan-out',
    owner: 'notifications',
    attempts: 3,
    backoffMs: 10 * SECOND,
    concurrency: 2,
    idempotency: 'claim scheduled → sending per revision; ambiguous push failures are not retried',
  },
  [QueueName.REFERRALS]: {
    purpose: 'Referral rewards, short-link cleanup, anonymisation clean-up',
    owner: 'growth',
    attempts: 5,
    backoffMs: 5 * SECOND,
    concurrency: 5,
    idempotency: 'conditional claim + rewards source key in one transaction',
  },
  [QueueName.WHATSAPP_WELCOME]: {
    purpose: 'WhatsApp (WATI) registration welcome and staff registration alert',
    owner: 'growth',
    attempts: 5,
    backoffMs: 30 * SECOND,
    concurrency: 2,
    // WATI API quota.
    limiter: { max: 60, duration: MINUTE },
    idempotency: 'welcome: log row claimed atomically, ambiguous sends → unknown; alert: send-once key',
  },
  [QueueName.CONTENT_PRAYER_ALERTS]: {
    purpose: 'Staff WhatsApp alert for a new prayer request',
    owner: 'content',
    attempts: 5,
    backoffMs: 30 * SECOND,
    concurrency: 2,
    limiter: { max: 30, duration: MINUTE },
    idempotency: 'alertSentAt mark + send-once key per request',
  },
  [QueueName.CONTENT_BIBLE_PURGE]: {
    purpose: 'Batched removal of Bible verses and marks after a delete',
    owner: 'content',
    attempts: 3,
    backoffMs: 10 * SECOND,
    concurrency: 1,
    idempotency: 'batched deletes; a sweep cron re-queues unfinished tasks',
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
