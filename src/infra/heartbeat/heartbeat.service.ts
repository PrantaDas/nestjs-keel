import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { hostname } from 'node:os';
import Redis from 'ioredis';
import { TimeService } from '@/common/time/time.service';
import { redisConfig } from '@/config/configuration';
import { REDIS_CORE } from '@/infra/redis/redis.constants';

export const PROCESS_MODE = Symbol('PROCESS_MODE');
export type ProcessMode = 'api' | 'graphql' | 'socket' | 'worker' | 'cron' | 'grpc';

/** What each running process reports about itself. */
export interface ProcessHeartbeat {
  mode: ProcessMode;
  /** `hostname:pid`, unique per running process. */
  instance: string;
  startedAt: string;
  lastSeenAt: string;
}

export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A process is listed until it misses about three beats (crashed or partitioned). */
export const HEARTBEAT_TTL_MS = 95_000;

export const heartbeatKey = (prefix: string, mode: ProcessMode, instance: string): string =>
  `${prefix}heartbeat:${mode}:${instance}`;
export const heartbeatPattern = (prefix: string): string => `${prefix}heartbeat:*`;

/**
 * Every process (api, socket, worker, cron) writes a short-lived heartbeat to the core Redis, so the
 * admin dashboard and the smoke test can see which processes are alive, including worker and cron,
 * which have no HTTP port. Best effort: a Redis outage only makes processes drop off the list.
 */
@Injectable()
export class HeartbeatService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(HeartbeatService.name);
  private readonly instance = `${hostname()}:${process.pid}`;
  private startedAt = '';
  private timer?: NodeJS.Timeout;
  private failing = false;

  constructor(
    @Inject(REDIS_CORE) private readonly redis: Redis,
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
    @Inject(PROCESS_MODE) private readonly mode: ProcessMode,
    private readonly time: TimeService,
  ) {}

  onApplicationBootstrap(): void {
    this.startedAt = this.time.now().toISOString();
    void this.beat();
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.redis.del(this.key()).catch(() => undefined);
  }

  async beat(): Promise<void> {
    const beat: ProcessHeartbeat = {
      mode: this.mode,
      instance: this.instance,
      startedAt: this.startedAt,
      lastSeenAt: this.time.now().toISOString(),
    };
    try {
      await this.redis.set(this.key(), JSON.stringify(beat), 'PX', HEARTBEAT_TTL_MS);
      if (this.failing) this.logger.log({ mode: this.mode }, 'Heartbeat restored');
      this.failing = false;
    } catch (err) {
      if (!this.failing) this.logger.warn({ err, mode: this.mode }, 'Heartbeat not written (core Redis unreachable)');
      this.failing = true;
    }
  }

  private key(): string {
    return heartbeatKey(this.config.keyPrefix, this.mode, this.instance);
  }
}
