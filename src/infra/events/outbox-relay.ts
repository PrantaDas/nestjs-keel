import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import { TimeService } from '@/common/time/time.service';
import { RateGate } from '@/common/utils/rate-gate';
import { transportConfig } from '@/config/configuration';
import type { DomainEvent } from '@/common/events/domain-event';
import { EventBus, ExternalEventPublisher } from './event-bus';
import { OutboxEvent } from './outbox.schema';

/** A claim lasts this long; a relay that dies mid-batch releases its events when it expires. */
const CLAIM_MS = 30_000;
/** After this many failed deliveries an event is parked as `failed` (ops lists it; retry by hand). */
export const OUTBOX_MAX_ATTEMPTS = 10;

/** Retry delay after `attempts` failures: 2 s, 4 s, … capped at 10 min, with jitter. */
export function outboxRetryDelayMs(attempts: number, random: () => number = Math.random): number {
  const step = Math.min(600_000, 2000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(step * (0.5 + random() / 2));
}

/**
 * Moves outbox events to their handlers (worker process only). Every `OUTBOX_POLL_INTERVAL_MS` it
 * claims a batch of due events with a token (so several worker instances never deliver the same
 * event at the same time), dispatches them in order, then marks each published or schedules a
 * retry. Delivery is at least once: a crash after the handlers ran and before the mark repeats them.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly errors = new RateGate(60_000);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    @InjectModel(OutboxEvent.name) private readonly model: Model<OutboxEvent>,
    private readonly bus: EventBus,
    private readonly time: TimeService,
    @Inject(transportConfig.KEY) private readonly config: ConfigType<typeof transportConfig>,
    @Optional() private readonly external?: ExternalEventPublisher,
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log({ handles: this.bus.handledTypes(), external: Boolean(this.external) }, 'Outbox relay started');
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** One relay pass; returns how many events were handled (tests call it directly). */
  async drain(): Promise<number> {
    const now = this.time.now();
    const token = randomUUID();
    const due = await this.model
      .find({
        status: 'pending',
        availableAt: { $lte: now },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
      })
      .sort({ availableAt: 1, _id: 1 })
      .limit(this.config.outbox.batchSize)
      .select({ _id: 1 })
      .lean()
      .exec();
    if (!due.length) return 0;

    // Claim only what is still unclaimed: a concurrent relay may have taken some meanwhile.
    await this.model.updateMany(
      { _id: { $in: due.map((doc) => doc._id) }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
      { $set: { claimToken: token, lockedUntil: this.time.after(CLAIM_MS, now) } },
    );
    const claimed = await this.model.find({ claimToken: token }).sort({ availableAt: 1, _id: 1 }).lean().exec();

    for (const row of claimed) {
      const event: DomainEvent = {
        eventId: row.eventId,
        type: row.type,
        payload: row.payload,
        occurredAt: row.occurredAt,
      };
      try {
        await this.bus.dispatch(event, this.external);
        await this.model.updateOne(
          { _id: row._id, claimToken: token },
          {
            $set: {
              status: 'published',
              publishedAt: this.time.now(),
              lockedUntil: null,
              claimToken: null,
              lastError: null,
            },
          },
        );
      } catch (err) {
        const attempts = row.attempts + 1;
        const failed = attempts >= OUTBOX_MAX_ATTEMPTS;
        await this.model.updateOne(
          { _id: row._id, claimToken: token },
          {
            $set: {
              status: failed ? 'failed' : 'pending',
              attempts,
              availableAt: this.time.after(outboxRetryDelayMs(attempts)),
              lockedUntil: null,
              claimToken: null,
              lastError: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
            },
          },
        );
        this.logger[failed ? 'error' : 'warn'](
          { err, eventId: row.eventId, type: row.type, attempts },
          failed ? 'Outbox event failed for good: parked' : 'Outbox event delivery failed, will retry',
        );
      }
    }
    return claimed.length;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = undefined;
        this.schedule();
      });
    }, this.config.outbox.pollIntervalMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      // Keep draining while full batches come back, so a backlog clears without waiting a tick each.
      while (!this.stopped && (await this.drain()) >= this.config.outbox.batchSize);
    } catch (err) {
      const gate = this.errors.pass('drain');
      if (gate.pass) {
        this.logger.warn({ err, suppressed: gate.suppressed }, 'Outbox relay pass failed (database down?)');
      }
    }
  }
}
