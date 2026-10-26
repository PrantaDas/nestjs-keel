import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { type Job, UnrecoverableError } from 'bullmq';
import { BaseException, SystemErrors } from '@/common/exceptions';

/**
 * Base for every BullMQ processor: subclasses implement `handle(job)`. Adds timing and
 * outcome logs per job, and reports a job to Sentry once it has failed for good: its last
 * attempt failed, or it threw `UnrecoverableError` (BullMQ never retries that, whatever attempts
 * are left). Errors that say a retry cannot help (`retryable === false`: permanent provider
 * answers, unknown send outcomes; or INTEGRATION_NOT_CONFIGURED) become UnrecoverableError, so
 * they fail at once instead of burning the remaining attempts.
 */
export abstract class BaseProcessor<TData = unknown, TResult = unknown> extends WorkerHost {
  protected readonly logger = new Logger(this.constructor.name);

  protected abstract handle(job: Job<TData, TResult>): Promise<TResult>;

  async process(job: Job<TData, TResult>): Promise<TResult> {
    const startedAt = performance.now();
    this.logger.log(
      { queue: job.queueName, jobId: job.id, jobName: job.name, attempt: job.attemptsMade + 1 },
      'Job started',
    );
    let result: TResult;
    try {
      result = await this.handle(job);
    } catch (error) {
      throw isRetryable(error) ? error : asUnrecoverable(error);
    }
    this.logger.log(
      { queue: job.queueName, jobId: job.id, jobName: job.name, durationMs: Math.round(performance.now() - startedAt) },
      'Job completed',
    );
    return result;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<TData, TResult> | undefined, error: Error): void {
    if (!job) return;
    const finalAttempt = isPermanentFailure(job, error);
    this.logger.error(
      { err: error, queue: job.queueName, jobId: job.id, jobName: job.name, attempt: job.attemptsMade, finalAttempt },
      finalAttempt ? 'Job failed permanently' : 'Job failed, will retry',
    );
    if (finalAttempt) {
      Sentry.withScope((scope) => {
        scope.setTags({ queue: job.queueName, jobName: job.name, jobId: String(job.id) });
        Sentry.captureException(error);
      });
    }
  }
}

/**
 * Whether BullMQ should retry after this error. False for UnrecoverableError, for errors that
 * carry `retryable: false` (integration exceptions, WatiError, …) and for INTEGRATION_NOT_CONFIGURED
 * (a retry minutes later cannot fix configuration). Anything else is retried (BullMQ's default).
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof UnrecoverableError || (error as Error | undefined)?.name === 'UnrecoverableError') return false;
  const hint = (error as { retryable?: unknown } | undefined)?.retryable;
  if (typeof hint === 'boolean') return hint;
  return !(error instanceof BaseException && error.errorCode === SystemErrors.INTEGRATION_NOT_CONFIGURED.code);
}

/** UnrecoverableError with the original message (BullMQ's failedReason) and the error as cause. */
export function asUnrecoverable(error: unknown): UnrecoverableError {
  const message = error instanceof Error ? error.message : String(error);
  const unrecoverable = new UnrecoverableError(message);
  (unrecoverable as { cause?: unknown }).cause = error;
  return unrecoverable;
}

/**
 * True when BullMQ will not retry the job: it moved to `failed` (`finishedOn` is set only then),
 * it threw `UnrecoverableError` (never retried), or no attempts are left.
 */
export function isPermanentFailure(job: Pick<Job, 'attemptsMade' | 'opts' | 'finishedOn'>, error: Error): boolean {
  if (error instanceof UnrecoverableError || error?.name === 'UnrecoverableError') return true;
  if (job.finishedOn) return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}
