import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { applyQueuePolicy } from './policy-worker';
import {
  jobOptionsFor,
  KEEP_COMPLETED,
  KEEP_FAILED,
  METRICS_DATA_POINTS,
  policyFor,
  QUEUE_POLICIES,
  workerOptionsFor,
} from './queue-policies';
import { QueueName } from './queue.constants';

describe('queue policies', () => {
  it('cover every queue, with bounded attempts, backoff and concurrency', () => {
    expect(Object.keys(QUEUE_POLICIES).sort()).toEqual(Object.values(QueueName).sort());
    for (const [name, policy] of Object.entries(QUEUE_POLICIES)) {
      expect({ name, ok: policy.attempts >= 1 && policy.attempts <= 10 }).toEqual({ name, ok: true });
      expect(policy.backoffMs).toBeGreaterThanOrEqual(1_000);
      expect(policy.concurrency).toBeGreaterThanOrEqual(1);
      expect(policy.purpose && policy.owner && policy.idempotency).toBeTruthy();
    }
  });

  it('rate-limit the queues that talk to providers with quotas (FCM, WATI)', () => {
    for (const name of [
      QueueName.CAMPAIGNS,
      QueueName.NOTIFICATION_DELIVERIES,
      QueueName.WHATSAPP_WELCOME,
      QueueName.CONTENT_PRAYER_ALERTS,
    ]) {
      expect(workerOptionsFor(name).limiter).toEqual(expect.objectContaining({ max: expect.any(Number) }));
    }
  });

  it('job defaults: jittered exponential backoff and bounded retention', () => {
    expect(jobOptionsFor(QueueName.REPORT_JOBS)).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000, jitter: 0.5 },
      removeOnComplete: KEEP_COMPLETED,
      removeOnFail: KEEP_FAILED,
    });
    expect(KEEP_COMPLETED).toEqual({ age: 86_400, count: 1_000 });
    expect(KEEP_FAILED).toEqual({ age: 604_800, count: 5_000 });
  });

  it('worker defaults: stalled handling and per-minute metrics', () => {
    expect(workerOptionsFor(QueueName.USERS)).toEqual({
      concurrency: 5,
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
      metrics: { maxDataPoints: METRICS_DATA_POINTS },
    });
  });

  it('unknown queues (tests) get defaults', () => {
    expect(policyFor('e2e-probe')).toMatchObject({ owner: 'unknown', attempts: 3, concurrency: 1 });
  });

  it('applyQueuePolicy sets the queue-level defaults over the root ones (and flags queues without a policy)', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // Only the public fields the applier touches (a real Queue would open a Redis connection).
    const queue = { name: QueueName.LIVE_QUIZ, jobsOpts: { attempts: 1, priority: 3 } } as unknown as Queue;
    applyQueuePolicy(queue);
    expect(queue.jobsOpts).toMatchObject({
      attempts: 5,
      priority: 3,
      backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
      removeOnFail: KEEP_FAILED,
    });
    expect(warn).not.toHaveBeenCalled();
    applyQueuePolicy({ name: 'e2e-probe', jobsOpts: {} } as unknown as Queue);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
