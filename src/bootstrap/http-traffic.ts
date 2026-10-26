import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { NextFunction, Request, Response } from 'express';
import { SystemErrors, SystemException } from '@/common/exceptions';
import { mapException } from '@/common/exceptions/exception-mapper';
import { RateGate } from '@/common/utils/rate-gate';

export interface HttpTimeouts {
  requestTimeoutMs: number;
  uploadRequestTimeoutMs: number;
}

/** Logged status of a request whose client hung up before the answer (nginx convention). */
export const CLIENT_CLOSED_STATUS = 499;

/** One Sentry event per minute for request timeouts (a slow dependency times out many at once). */
const timeoutReports = new RateGate(60_000);

/**
 * Tracks every HTTP request from arrival to answer (registered first, before any other middleware):
 * - request timeout: a request still unanswered after `REQUEST_TIMEOUT_MS`
 *   (`REQUEST_TIMEOUT_UPLOAD_MS` for multipart uploads) gets 503 REQUEST_TIMEOUT with the error
 *   envelope. The handler is not cancelled: writes already sent may still complete, and its late
 *   answer is dropped (clients must treat a timeout as "outcome unknown"; writes are idempotent);
 * - client aborts: the request is logged with status 499 at info level; the handler keeps running
 *   to completion (no partial writes), its answer goes nowhere;
 * - shutdown: knows what is still in flight, so the drain waits exactly for it, answers whatever is
 *   left at the deadline with 503, and marks responses `Connection: close` so keep-alive clients
 *   reconnect to another instance.
 */
export class HttpTraffic {
  private readonly logger = new Logger(HttpTraffic.name);
  private readonly inFlight = new Set<Response>();
  private readonly idleWaiters = new Set<() => void>();
  private draining = false;

  constructor(private readonly timeouts: HttpTimeouts) {}

  get size(): number {
    return this.inFlight.size;
  }

  readonly middleware = (req: Request, res: Response, next: NextFunction): void => {
    this.inFlight.add(res);
    const timeoutMs = req.is('multipart/form-data')
      ? this.timeouts.uploadRequestTimeoutMs
      : this.timeouts.requestTimeoutMs;
    const startedAt = performance.now();
    const timer = setTimeout(() => this.timedOut(req, res, timeoutMs), timeoutMs);
    timer.unref();

    const settle = () => {
      clearTimeout(timer);
      if (!res.writableEnded && !res.headersSent) {
        // Client hung up first: logged as 499 (pino-http logs on `close`, after this listener).
        res.statusCode = CLIENT_CLOSED_STATUS;
        this.logger.debug(
          { requestId: req.id, path: req.originalUrl, durationMs: Math.round(performance.now() - startedAt) },
          'Client closed the request before the answer',
        );
      }
      this.inFlight.delete(res);
      if (this.inFlight.size === 0) this.idleWaiters.forEach((wake) => wake());
    };
    res.once('finish', settle);
    res.once('close', settle);
    if (this.draining) res.setHeader('Connection', 'close');
    next();
  };

  /** Shutdown started: every answer from now on closes its connection. */
  beginDrain(): void {
    this.draining = true;
    for (const res of this.inFlight) if (!res.headersSent) res.setHeader('Connection', 'close');
  }

  /** Resolves true once nothing is in flight, false if `timeoutMs` passes first. */
  drained(timeoutMs: number): Promise<boolean> {
    if (this.inFlight.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (idle: boolean) => {
        clearTimeout(timer);
        this.idleWaiters.delete(wake);
        resolve(idle);
      };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      timer.unref();
      this.idleWaiters.add(wake);
    });
  }

  /** Shutdown deadline: answers every request still running with 503 before the sockets close. */
  answerRemaining(): number {
    let answered = 0;
    for (const res of this.inFlight) {
      if (this.answer(res, new SystemException(SystemErrors.SERVICE_UNAVAILABLE), true)) answered += 1;
    }
    return answered;
  }

  private timedOut(req: Request, res: Response, timeoutMs: number): void {
    const context = { requestId: req.id, method: req.method, path: req.originalUrl, timeoutMs };
    if (!this.answer(res, new SystemException(SystemErrors.REQUEST_TIMEOUT), false)) return;
    this.logger.warn(context, 'Request timed out: answered 503, the handler keeps running');
    const gate = timeoutReports.pass('request-timeout');
    if (gate.pass) {
      Sentry.withScope((scope) => {
        scope.setTags({ requestId: typeof req.id === 'string' ? req.id : 'none', method: req.method });
        scope.setExtra('suppressedSinceLastReport', gate.suppressed);
        Sentry.captureMessage(`Request timed out after ${timeoutMs} ms: ${req.method} ${req.originalUrl}`, 'warning');
      });
    }
  }

  /** Writes the error envelope if the response is still open; false when it was already answered. */
  private answer(res: Response, exception: SystemException, closeConnection: boolean): boolean {
    if (res.headersSent || res.writableEnded || res.destroyed) return false;
    const req = res.req as Request | undefined;
    const { status, body } = mapException(exception, typeof req?.id === 'string' ? req.id : undefined);
    if (closeConnection || this.draining) res.setHeader('Connection', 'close');
    res.status(status).json(body);
    return true;
  }
}
