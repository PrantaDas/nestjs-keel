import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { type Connection, type ConnectOptions, ConnectionStates } from 'mongoose';
import { mongoConfig, runtimeConfig } from '@/config/configuration';

type MongoConfig = ConfigType<typeof mongoConfig>;
type Resilience = ConfigType<typeof runtimeConfig>;
/** `bufferTimeoutMS` is a Mongoose connection option missing from its `ConnectOptions` type. */
export type MongoConnectOptions = ConnectOptions & { bufferTimeoutMS: number };

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

/**
 * Driver options shared by the first connection and the reconnect attempts. Every wait is bounded,
 * so a query fails fast (503 DATABASE_UNAVAILABLE) instead of hanging while MongoDB is down:
 * - serverSelectionTimeoutMS: how long an operation waits for a usable server (failover included);
 * - bufferTimeoutMS: how long Mongoose holds a query while the connection is down (same value);
 * - waitQueueTimeoutMS: how long a query waits for a pooled connection while all are busy (slow DB);
 * - maxPoolSize: connections per process; requests beyond it queue, never open more sockets.
 */
export function mongoConnectOptions(config: MongoConfig, resilience: Resilience): MongoConnectOptions {
  const { mongo } = resilience;
  return {
    autoIndex: config.autoIndex,
    maxPoolSize: config.maxPoolSize,
    serverSelectionTimeoutMS: mongo.serverSelectionTimeoutMs,
    connectTimeoutMS: mongo.connectTimeoutMs,
    waitQueueTimeoutMS: mongo.waitQueueTimeoutMs,
    bufferTimeoutMS: mongo.serverSelectionTimeoutMs,
  };
}

/** Exponential backoff with jitter (50–100 % of the step), capped at 30 s. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const step = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(step * (0.5 + random() / 2));
}

/**
 * The MongoDB connection is opened lazily, so a database that is down at boot does not stop the
 * process: it boots degraded (readiness reports `mongodb` down, queries answer 503) and this
 * supervisor keeps retrying the first connection with backoff until it succeeds. The driver takes
 * over from there: after the first success it reconnects on its own when the server comes back.
 */
@Injectable()
export class MongoConnectionSupervisor implements OnModuleInit, BeforeApplicationShutdown {
  /** Set once the app starts closing: the disconnect that follows is expected, not logged as an outage. */
  static closing = false;
  private readonly logger = new Logger('MongoDB');
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private attempts = 0;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Inject(mongoConfig.KEY) private readonly config: MongoConfig,
    @Inject(runtimeConfig.KEY) private readonly resilience: Resilience,
  ) {}

  /**
   * Waits for the first connection up to the server selection timeout, so a normal boot is warm
   * (indexes, `connection.db`), then lets the boot continue whatever happened.
   */
  async onModuleInit(): Promise<void> {
    MongoConnectionSupervisor.closing = false;
    if (this.connection.readyState === ConnectionStates.connected) return;
    const first = this.connection.asPromise().then(
      () => true,
      () => false,
    );
    let timer: NodeJS.Timeout | undefined;
    const connected = await Promise.race([
      first,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.resilience.mongo.serverSelectionTimeoutMs + 500);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (connected) return;
    this.logger.warn('MongoDB unreachable at boot: starting degraded, retrying in background');
    // The first attempt may still be running: retry once it has failed for good.
    void first.then((ok) => (ok ? undefined : this.schedule()));
  }

  beforeApplicationShutdown(): void {
    MongoConnectionSupervisor.closing = true;
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.attempts += 1;
    const delay = reconnectDelayMs(this.attempts);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconnect();
    }, delay);
    this.timer.unref();
  }

  private async reconnect(): Promise<void> {
    const state = this.connection.readyState;
    if (this.stopped || state === ConnectionStates.connected || state === ConnectionStates.connecting) return;
    try {
      await this.connection.openUri(this.config.uri, mongoConnectOptions(this.config, this.resilience));
      this.logger.log({ attempts: this.attempts }, 'MongoDB connected after a failed boot connection');
      this.attempts = 0;
    } catch (err) {
      if (this.attempts === 1 || this.attempts % 10 === 0) {
        this.logger.error({ err, attempts: this.attempts }, 'MongoDB still unreachable, retrying');
      }
      this.schedule();
    }
  }
}
