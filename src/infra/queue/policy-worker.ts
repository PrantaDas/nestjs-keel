import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Queue, Worker, type ConnectionOptions, type Processor, type QueueOptions, type WorkerOptions } from 'bullmq';
import { jobOptionsFor, policyFor, workerOptionsFor } from './queue-policies';

const logger = new Logger('QueuePolicies');

/**
 * The Worker class every `@Processor` gets (`BullModule.workerClass`): the queue's policy
 * (concurrency, rate limit, lock / stalled settings, metrics) is merged over the decorator's options.
 */
export class PolicyWorker extends Worker {
  constructor(name: string, processor?: string | URL | null | Processor, opts?: WorkerOptions) {
    const policy = workerOptionsFor(name);
    if (opts?.concurrency !== undefined && opts.concurrency !== policy.concurrency) {
      logger.warn(
        { queue: name, decorator: opts.concurrency, policy: policy.concurrency },
        '@Processor concurrency differs from the queue policy; the policy applies',
      );
    }
    super(name, processor, { ...(opts as WorkerOptions), ...policy });
    this.on('error', reportThrottled(name));
  }
}

/** One log line for the first worker error, then at most one per window with the count in between. */
export function reportThrottled(queue: string, windowMs = 30_000, now: () => number = () => performance.now()) {
  let lastAt = -Infinity;
  let suppressed = 0;
  return (err: Error): void => {
    const at = now();
    if (at - lastAt < windowMs) {
      suppressed += 1;
      return;
    }
    logger.error({ err, queue, suppressed }, 'Queue worker error (connection or processing infrastructure)');
    lastAt = at;
    suppressed = 0;
  };
}

/**
 * The Queue class every `registerQueue` gets (`BullModule.queueClass`). Producers fail fast while
 * the core Redis is unreachable (no offline queue, one reconnect per command, a command timeout)
 * instead of hanging the request or job that enqueues. Workers keep their own blocking connection.
 */
export class PolicyQueue extends Queue {
  /** Set from runtime config when the queue module starts (`REDIS_COMMAND_TIMEOUT_MS`). */
  static producerCommandTimeoutMs = 3000;

  constructor(name: string, opts?: QueueOptions) {
    super(name, opts && { ...opts, connection: producerConnection(opts.connection) });
  }
}

export function producerConnection(connection: ConnectionOptions): ConnectionOptions {
  if (typeof (connection as { duplicate?: unknown }).duplicate === 'function') {
    return connection; // a client instance: its owner configured it
  }
  return {
    ...connection,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: PolicyQueue.producerCommandTimeoutMs,
  };
}

/**
 * Applies each queue's job defaults (attempts, jittered exponential backoff, bounded retention)
 * to every Queue instance of the app at start, before anything is enqueued. Feature modules keep
 * registering their queues by name only; the policy table stays the single source.
 */
@Injectable()
export class QueuePolicyApplier implements OnModuleInit {
  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (instance instanceof Queue) applyQueuePolicy(instance as Queue);
    }
  }
}

/** Queue-level job defaults from the policy (root defaults stay underneath; per-job options win). */
export function applyQueuePolicy(queue: Queue): void {
  queue.jobsOpts = { ...queue.jobsOpts, ...jobOptionsFor(queue.name) };
  if (policyFor(queue.name).owner === 'unknown') {
    logger.warn({ queue: queue.name }, 'Queue has no policy in queue-policies.ts; defaults apply');
  }
}
