import type { Job } from 'bullmq';
import { redactSecrets } from '@/integrations/resilience/failure';

const MINUTE_MS = 60_000;

/** BullMQ `getMetrics` result (per-minute counters kept by the workers, `metrics` worker option). */
export interface QueueMetrics {
  meta: { count: number; prevTS: number; prevCount: number };
  data: number[];
}

/**
 * Jobs counted by BullMQ metrics in the last `windowMinutes` (default 24 h), independent of job
 * retention. `data[i]` is the minute `prevTS − 1 − i`; jobs since the last roll-over (`count −
 * prevCount`) belong to the minute of `prevTS`.
 */
export function countInWindow(metrics: QueueMetrics, nowMs: number, windowMinutes = 24 * 60): number {
  const { count, prevTS, prevCount } = metrics.meta;
  if (!prevTS) return 0;
  const age = Math.floor(nowMs / MINUTE_MS) - Math.floor(prevTS / MINUTE_MS);
  if (age >= windowMinutes) return 0;
  const pending = Math.max(0, count - prevCount);
  const take = Math.max(0, windowMinutes - age - 1);
  return pending + metrics.data.slice(0, take).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

/** One failed job for the ops list: never the payload (it may hold personal data or tokens). */
export interface FailedJobView {
  id: string;
  name: string;
  attemptsMade: number;
  maxAttempts: number;
  /** Error message of the last attempt, secrets redacted, at most 500 characters. */
  failedReason: string;
  createdAt: Date | null;
  processedAt: Date | null;
  failedAt: Date | null;
}

const at = (ms: number | null | undefined): Date | null => (typeof ms === 'number' && ms > 0 ? new Date(ms) : null);

export function toFailedJobView(
  job: Pick<Job, 'id' | 'name' | 'attemptsMade' | 'opts' | 'failedReason' | 'timestamp' | 'processedOn' | 'finishedOn'>,
): FailedJobView {
  return {
    id: String(job.id),
    name: job.name,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts?.attempts ?? 1,
    failedReason: redactSecrets(job.failedReason || 'unknown'),
    createdAt: at(job.timestamp),
    processedAt: at(job.processedOn),
    failedAt: at(job.finishedOn),
  };
}
