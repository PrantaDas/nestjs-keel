import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { ConfigType } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import { RequestContext } from '@/common/context/request-context';
import { PaginatedResult } from '@/common/dto/pagination.dto';
import { TimeService } from '@/common/time/time.service';
import { redisConfig } from '@/config/configuration';
import { heartbeatPattern, type ProcessHeartbeat, type ProcessMode } from '@/infra/heartbeat/heartbeat.service';
import { policyFor } from '@/infra/queue/queue-policies';
import { REDIS_CORE } from '@/infra/redis/redis.constants';
import { QueueName } from '@/infra/queue/queue.constants';
import { redactSecrets } from '@/integrations/resilience/failure';
import { OutboxEvent } from '@/infra/events/outbox.schema';
import { FailedJobsQueryDto } from './dto/ops.dto';
import { countInWindow, FailedJobView, toFailedJobView } from './ops.helpers';
import { OpsErrors, OpsException } from './ops.errors';
import { QueueInspector } from './queue-inspector.service';

export interface QueueOverview {
  name: QueueName;
  purpose: string;
  owner: string;
  paused: boolean;
  counts: { waiting: number; active: number; delayed: number; failed: number };
  /** From the workers' per-minute metrics, so retention limits do not cut it short. */
  completedLast24h: number;
  failedLast24h: number;
  /** Worker connections listening on the queue now; null when Redis does not allow counting them. */
  workers: number | null;
}

export interface RetriedJob {
  queue: QueueName;
  id: string;
  name: string;
  state: 'waiting';
}

const DAY_MINUTES = 24 * 60;
const MODE_ORDER: Record<ProcessMode, number> = { api: 0, graphql: 1, socket: 2, worker: 3, cron: 4, grpc: 5 };
/** Upper bound for the heartbeat scan (far above any real deployment). */
const MAX_PROCESSES = 500;

/**
 * Operations view for staff: queue counts, the failed-job list (no payloads), retry / discard
 * (super admins, audited), running processes from their heartbeats, and outbox events parked after
 * too many failed deliveries. Works on every queue of `QueueName` through one shared connection.
 */
@Injectable()
export class OpsService {
  constructor(
    private readonly queues: QueueInspector,
    private readonly time: TimeService,
    @Inject(REDIS_CORE) private readonly redis: Redis,
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
  ) {}

  /** Domain events the relay gave up on, newest first (no payloads). */
  async failedEvents(query: FailedJobsQueryDto) {
    const filter = { status: 'failed' as const };
    const [rows, total] = await Promise.all([
      this.outbox
        .find(filter, { eventId: 1, type: 1, attempts: 1, lastError: 1, occurredAt: 1 })
        .sort({ occurredAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean()
        .exec(),
      this.outbox.countDocuments(filter).exec(),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / query.limit));
    const items = rows.map((row) => ({
      eventId: row.eventId,
      type: row.type,
      attempts: row.attempts,
      lastError: row.lastError ? redactSecrets(row.lastError) : null,
      occurredAt: row.occurredAt,
    }));
    return new PaginatedResult(items, {
      page: query.page,
      limit: query.limit,
      totalDocs: total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPrevPage: query.page > 1,
    });
  }

  /** Puts a parked event back for the relay with a fresh attempt budget (handlers are idempotent). */
  async retryEvent(eventId: string): Promise<{ eventId: string; status: 'pending' }> {
    const updated = await this.outbox
      .findOneAndUpdate(
        { eventId, status: 'failed' },
        { $set: { status: 'pending', attempts: 0, availableAt: this.time.now(), lockedUntil: null, claimToken: null } },
      )
      .lean()
      .exec();
    if (!updated) throw new OpsException(OpsErrors.OPS_EVENT_NOT_FOUND);
    RequestContext.recordAudit({ resourceId: eventId, metadata: { type: updated.type, attempts: updated.attempts } });
    return { eventId, status: 'pending' };
  }

  async overview(): Promise<QueueOverview[]> {
    const now = this.time.now().getTime();
    return Promise.all(
      this.queues.names().map(async (name) => {
        const queue = this.queues.queue(name);
        const [counts, paused, completed, failed, workers] = await Promise.all([
          queue.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed'),
          queue.isPaused(),
          queue.getMetrics('completed', 0, DAY_MINUTES - 1),
          queue.getMetrics('failed', 0, DAY_MINUTES - 1),
          // CLIENT LIST; some managed Redis plans refuse it.
          queue.getWorkersCount().catch(() => null),
        ]);
        const policy = policyFor(name);
        return {
          name,
          purpose: policy.purpose,
          owner: policy.owner,
          paused,
          counts: {
            waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
          },
          completedLast24h: countInWindow(completed, now),
          failedLast24h: countInWindow(failed, now),
          workers,
        };
      }),
    );
  }

  /** Processes alive now (every kind), from their heartbeats in the core Redis. */
  async processes(): Promise<ProcessHeartbeat[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        heartbeatPattern(this.config.keyPrefix),
        'COUNT',
        200,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0' && keys.length < MAX_PROCESSES);
    if (!keys.length) return [];
    const values = await this.redis.mget(keys.slice(0, MAX_PROCESSES));
    return values
      .flatMap((value) => {
        if (!value) return [];
        try {
          return [JSON.parse(value) as ProcessHeartbeat];
        } catch {
          return [];
        }
      })
      .sort((a, b) => MODE_ORDER[a.mode] - MODE_ORDER[b.mode] || a.instance.localeCompare(b.instance));
  }

  async failed(name: string, query: FailedJobsQueryDto): Promise<PaginatedResult<FailedJobView>> {
    const queue = this.require(name);
    const start = (query.page - 1) * query.limit;
    const [jobs, total] = await Promise.all([queue.getFailed(start, start + query.limit - 1), queue.getFailedCount()]);
    const items = jobs.filter((job): job is Job => Boolean(job)).map(toFailedJobView);
    const totalPages = Math.max(1, Math.ceil(total / query.limit));
    return new PaginatedResult(items, {
      page: query.page,
      limit: query.limit,
      totalDocs: total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPrevPage: query.page > 1,
    });
  }

  /** Back to waiting with a fresh attempt budget; the processor's claims keep side effects single. */
  async retry(name: string, jobId: string): Promise<RetriedJob> {
    const queue = this.require(name);
    const job = await this.requireFailed(queue, jobId);
    try {
      await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
    } catch (err) {
      // Lost a race with another retry / discard: the job left the failed list meanwhile.
      if ((await queue.getJobState(jobId)) !== 'failed') {
        throw new OpsException(OpsErrors.OPS_JOB_NOT_FAILED, { cause: err });
      }
      throw err;
    }
    this.audit(name, job);
    return { queue: name as QueueName, id: String(job.id), name: job.name, state: 'waiting' };
  }

  async discard(name: string, jobId: string): Promise<void> {
    const queue = this.require(name);
    const job = await this.requireFailed(queue, jobId);
    try {
      await job.remove();
    } catch (err) {
      if ((await queue.getJobState(jobId)) !== 'failed') {
        throw new OpsException(OpsErrors.OPS_JOB_NOT_FAILED, { cause: err });
      }
      throw err;
    }
    this.audit(name, job);
  }

  private audit(name: string, job: Job): void {
    RequestContext.recordAudit({
      resourceId: `${name}/${String(job.id)}`,
      metadata: {
        queue: name,
        jobId: String(job.id),
        jobName: job.name,
        attemptsMade: job.attemptsMade,
        failedReason: redactSecrets(job.failedReason || ''),
      },
    });
  }

  private require(name: string): Queue {
    if (!this.queues.has(name)) throw new OpsException(OpsErrors.OPS_QUEUE_NOT_FOUND);
    return this.queues.queue(name);
  }

  private async requireFailed(queue: Queue, jobId: string): Promise<Job> {
    const job = await queue.getJob(jobId);
    if (!job) throw new OpsException(OpsErrors.OPS_JOB_NOT_FOUND);
    if ((await job.getState()) !== 'failed') throw new OpsException(OpsErrors.OPS_JOB_NOT_FAILED);
    return job;
  }
}
