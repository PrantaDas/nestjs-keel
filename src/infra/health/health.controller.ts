import { Controller, Get, HttpStatus, Inject, Optional, Req, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import Redis from 'ioredis';
import { type Connection, ConnectionStates } from 'mongoose';
import { Public } from '@/common/auth/auth.decorators';
import { ResponseMessage, SkipEnvelope } from '@/common/decorators/response.decorators';
import { SystemErrors, SystemException } from '@/common/exceptions';
import { mapException } from '@/common/exceptions/exception-mapper';
import { ApiEnvelope, ApiStandardErrors } from '@/common/swagger';
import { TimeService } from '@/common/time/time.service';
import { AppLifecycle } from '@/infra/lifecycle/app-lifecycle';
import { REDIS_CACHE, REDIS_CORE } from '@/infra/redis/redis.constants';
import { LivenessResponse, ReadinessResponse } from './health.responses';

const PING_TIMEOUT_MS = 1500;

export interface DependencyCheck {
  status: 'up' | 'down';
  /** False for dependencies the app can serve without (the cache): down means degraded, not unready. */
  required: boolean;
  message?: string;
}

export interface Readiness {
  /** `degraded`: serving, but an optional dependency is down (cache: requests go uncached). */
  status: 'ok' | 'degraded';
  details: Record<string, DependencyCheck>;
}

/**
 * Version-neutral so load balancer checks survive API version bumps: `/api/health`, `/api/ready`.
 * Served by every HTTP process (api, graphql, socket); worker and cron report through heartbeats.
 */
@ApiTags('Health')
@Public()
@SkipThrottle()
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    @InjectConnection() private readonly mongo: Connection,
    private readonly time: TimeService,
    @Inject(REDIS_CORE) private readonly redisCore: Redis,
    @Inject(REDIS_CACHE) private readonly redisCache: Redis | null,
    @Optional() private readonly lifecycle?: AppLifecycle,
  ) {}

  /**
   * Liveness: the process is up and its event loop answers. No dependency checks, so a database or
   * Redis outage never gets healthy processes restarted. `serverTime` lets apps sync clocks.
   */
  @Get('health')
  @ApiOperation({ summary: 'Liveness: the process is up (no dependency checks)', operationId: 'healthLive' })
  @ApiEnvelope(LivenessResponse)
  @ResponseMessage('Service is running.')
  live() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()), serverTime: this.time.now().toISOString() };
  }

  /**
   * Readiness: MongoDB and the core Redis must answer, and the process must not be shutting down;
   * otherwise 503 with the failing parts in `details`. The cache Redis is optional: when it is down
   * the answer stays 200 with `status: degraded`.
   */
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness: MongoDB and core Redis answer, not shutting down (cache Redis optional)',
    operationId: 'healthReady',
  })
  @ApiEnvelope(ReadinessResponse)
  @ApiStandardErrors(SystemErrors.SERVICE_UNAVAILABLE)
  @SkipEnvelope()
  async ready(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const details: Record<string, DependencyCheck> = {};
    const [mongodb, redisCore, redisCache] = await Promise.all([
      this.check(true, () => this.pingMongo()),
      this.check(true, () => this.pingRedis(this.redisCore)),
      this.redisCache
        ? this.check(false, () => this.pingRedis(this.redisCache!))
        : Promise.resolve<DependencyCheck>({ status: 'up', required: false, message: 'not configured' }),
    ]);
    Object.assign(details, { mongodb, redisCore, redisCache });
    if (this.lifecycle?.isShuttingDown) {
      details.lifecycle = { status: 'down', required: true, message: 'shutting down' };
    }

    const failing = Object.entries(details).filter(([, check]) => check.required && check.status === 'down');
    if (failing.length) {
      const exception = new SystemException(SystemErrors.SERVICE_UNAVAILABLE, {
        details: failing.map(([field, check]) => ({ field, message: check.message ?? 'down' })),
      });
      // Answered here, not thrown: a failing probe is expected (outage, deploy) and must not log
      // an error or reach Sentry every few seconds.
      const { status, body } = mapException(exception, typeof req.id === 'string' ? req.id : undefined);
      res.status(status);
      return body;
    }

    const degraded = Object.values(details).some((check) => check.status === 'down');
    res.status(HttpStatus.OK);
    const data: Readiness = { status: degraded ? 'degraded' : 'ok', details };
    return { success: true, message: 'Service is ready.', data };
  }

  private async check(required: boolean, probe: () => Promise<void>): Promise<DependencyCheck> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        probe(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${PING_TIMEOUT_MS} ms`)), PING_TIMEOUT_MS);
        }),
      ]);
      return { status: 'up', required };
    } catch (error) {
      return { status: 'down', required, message: error instanceof Error ? error.message : 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  private async pingMongo(): Promise<void> {
    if (this.mongo.readyState !== ConnectionStates.connected || !this.mongo.db) throw new Error('not connected');
    await this.mongo.db.admin().ping();
  }

  private async pingRedis(client: Redis): Promise<void> {
    if (client.status !== 'ready') throw new Error(`not connected (${client.status})`);
    await client.ping();
  }
}
