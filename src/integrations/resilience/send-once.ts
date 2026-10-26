import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';
import { redisConfig } from '@/config/configuration';
import { REDIS_CORE } from '@/infra/redis/redis.constants';
import { classifyFailure, IntegrationCallException, IntegrationOutcomeUnknownException } from './failure';

/** How long a claim is remembered: far longer than any job retry window or duplicate enqueue. */
export const SEND_CLAIM_TTL_MS = 30 * 24 * 60 * 60_000;
/** A `pending` claim younger than this is a send in flight (retry later); older = it died mid-call. */
export const SEND_IN_FLIGHT_MS = 5 * 60_000;

export type SendOnceStatus = 'sent' | 'duplicate';

const PENDING = 'pending';
const SENT = 'sent';
const UNKNOWN = 'unknown';

// Delete only while still pending (never drop a `sent` or `unknown` mark).
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * "At most once" for non-idempotent sends (WhatsApp, email) that BullMQ may run again (retry,
 * stalled job, duplicate enqueue). The claim is taken in the core Redis BEFORE the provider call:
 *
 *   claim (SET NX) → call → `sent`                              (later runs: `duplicate`, no call)
 *                         → definite failure → claim released   (a retry may send)
 *                         → ambiguous failure → `unknown`        (never repeated automatically)
 *
 * A process that dies mid-call leaves `pending`; once older than SEND_IN_FLIGHT_MS it is treated
 * as unknown. Unknown outcomes surface as IntegrationOutcomeUnknownException (job fails, visible
 * in the ops failed-jobs list), never as a second message.
 */
@Injectable()
export class SendOnceGuard {
  private readonly logger = new Logger(SendOnceGuard.name);

  constructor(
    @Inject(REDIS_CORE) private readonly redis: Redis,
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
  ) {}

  /** Runs `send` once per `onceKey`; without a key it simply runs it. */
  async run(integration: string, onceKey: string | undefined, send: () => Promise<unknown>): Promise<SendOnceStatus> {
    if (!onceKey) {
      await send();
      return 'sent';
    }
    const key = this.key(onceKey);
    const claimed = await this.redis.set(key, PENDING, 'PX', SEND_CLAIM_TTL_MS, 'NX');
    if (claimed !== 'OK') return this.existing(integration, key);

    try {
      await send();
    } catch (error) {
      if (classifyFailure(error).ambiguous) {
        await this.redis.set(key, UNKNOWN, 'PX', SEND_CLAIM_TTL_MS).catch(() => undefined);
        this.logger.warn({ integration, onceKey }, 'Send outcome unknown: kept as claimed, never repeated');
        throw new IntegrationOutcomeUnknownException(integration, error);
      }
      // Definitely not delivered: give the claim back so the job's retry can send.
      await this.redis.eval(RELEASE_SCRIPT, 1, key, PENDING).catch(() => undefined);
      throw error;
    }

    try {
      await this.redis.set(key, SENT, 'PX', SEND_CLAIM_TTL_MS);
    } catch (err) {
      // Delivered; the pending mark stays and ages into "unknown" — never a second send.
      this.logger.warn({ err, integration, onceKey }, 'Could not record a delivered send');
    }
    return 'sent';
  }

  private async existing(integration: string, key: string): Promise<SendOnceStatus> {
    const [value, ttl] = await Promise.all([this.redis.get(key), this.redis.pttl(key)]);
    if (value === SENT) return 'duplicate';
    if (value === PENDING && ttl > 0 && SEND_CLAIM_TTL_MS - ttl < SEND_IN_FLIGHT_MS) {
      // Another worker is sending right now: retry later, and then see its outcome.
      throw new IntegrationCallException(integration, { transient: true, ambiguous: false, reason: 'send_in_flight' });
    }
    if (value === null) {
      // Released between our SET and GET: a definite failure elsewhere; try again later.
      throw new IntegrationCallException(integration, { transient: true, ambiguous: false, reason: 'claim_released' });
    }
    throw new IntegrationOutcomeUnknownException(integration);
  }

  private key(onceKey: string): string {
    return `${this.config.keyPrefix}send-once:${onceKey}`;
  }
}
