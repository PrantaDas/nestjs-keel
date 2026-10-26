import { CallHandler, ExecutionContext, Inject, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Request, Response } from 'express';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { from, mergeMap, Observable, of, tap } from 'rxjs';
import { RequestErrors, RequestException } from '@/common/exceptions';
import { redisConfig, throttleConfig } from '@/config/configuration';
import { REDIS_CORE } from '@/infra/redis/redis.constants';

const HEADER = 'idempotency-key';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
/** How long a request may run before its pending claim lapses (a crashed process frees the key). */
const PENDING_MS = 60_000;

interface Stored {
  state: 'pending' | 'done';
  fingerprint: string;
  value?: unknown;
}

/**
 * `Idempotency-Key` on unsafe routes (POST/PUT/PATCH/DELETE), opt-in by the client: the first
 * request with a key runs, a repeat with the same key and body gets the same answer (with
 * `Idempotent-Replayed: true`) without running the handler again, a repeat while the first is still
 * running gets 409, and the same key with a different body gets 422. Keys are scoped to the caller
 * (user, API client or IP) and the route, and kept IDEMPOTENCY_TTL_SECONDS. A failed request frees
 * its key so the client can retry. Fails closed: without Redis a keyed request answers 503.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    @Inject(REDIS_CORE) private readonly redis: Redis,
    @Inject(redisConfig.KEY) private readonly redisSettings: ConfigType<typeof redisConfig>,
    @Inject(throttleConfig.KEY) private readonly config: ConfigType<typeof throttleConfig>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers[HEADER];
    if (!UNSAFE.has(request.method) || header === undefined) return next.handle();
    if (typeof header !== 'string' || !KEY_PATTERN.test(header)) {
      throw new RequestException(RequestErrors.INVALID_IDEMPOTENCY_KEY);
    }

    const key = this.storageKey(request, header);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(request.body ?? null))
      .digest('hex');
    const response = context.switchToHttp().getResponse<Response>();

    return from(this.claim(key, fingerprint)).pipe(
      mergeMap((existing) => {
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new RequestException(RequestErrors.IDEMPOTENCY_KEY_REUSED);
          if (existing.state === 'pending') throw new RequestException(RequestErrors.IDEMPOTENCY_IN_PROGRESS);
          response.setHeader('Idempotent-Replayed', 'true');
          return of(existing.value);
        }
        return next.handle().pipe(
          tap({
            next: (value) => void this.complete(key, fingerprint, value),
            error: () => void this.release(key),
          }),
        );
      }),
    );
  }

  /** Null when this request owns the key now; the stored entry when someone used it before. */
  private async claim(key: string, fingerprint: string): Promise<Stored | null> {
    const pending: Stored = { state: 'pending', fingerprint };
    const claimed = await this.redis.set(key, JSON.stringify(pending), 'PX', PENDING_MS, 'NX');
    if (claimed === 'OK') return null;
    const raw = await this.redis.get(key);
    // Expired between the two calls: treat as in progress, the client retries in a moment.
    return raw ? (JSON.parse(raw) as Stored) : pending;
  }

  private async complete(key: string, fingerprint: string, value: unknown): Promise<void> {
    const done: Stored = { state: 'done', fingerprint, value };
    await this.redis
      .set(key, JSON.stringify(done), 'EX', this.config.idempotencyTtlSeconds)
      .catch((err: unknown) => this.logger.warn({ err }, 'Idempotent response not stored: a repeat would run again'));
  }

  private async release(key: string): Promise<void> {
    await this.redis.del(key).catch(() => undefined);
  }

  private storageKey(request: Request, key: string): string {
    const caller = request.user
      ? `u:${request.user.id}`
      : request.apiClient
        ? `k:${request.apiClient.name}`
        : `ip:${request.ip}`;
    const route = (request.route as { path?: string } | undefined)?.path ?? request.path;
    const scope = createHash('sha256').update(`${caller}|${request.method}|${route}|${key}`).digest('hex').slice(0, 40);
    return `${this.redisSettings.keyPrefix}idempotency:${scope}`;
  }
}
