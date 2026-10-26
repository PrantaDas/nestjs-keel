import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { Request, Response } from 'express';
import { RequestContext } from '@/common/context/request-context';
import { bodyFieldsOf, mapException } from '@/common/exceptions/exception-mapper';
import { RateGate } from '@/common/utils/rate-gate';

/** Seconds a client should wait before retrying after a dependency outage (503). */
const OUTAGE_RETRY_AFTER_SECONDS = 5;

/** One Sentry event per dependency per minute during an outage, not one per failed request. */
const outageReports = new RateGate(60_000);

/** Single exit point for HTTP errors: envelope, status, log, Sentry. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;

    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const requestId = typeof request.id === 'string' ? request.id : RequestContext.requestId();

    // The request already got its answer (timeout, shutdown drain or client abort) and the handler
    // finished later: its late write is expected, not a bug.
    if (response.headersSent && (exception as { code?: unknown })?.code === 'ERR_HTTP_HEADERS_SENT') {
      this.logger.debug({ requestId, path: request.originalUrl }, 'Late response dropped: request already answered');
      return;
    }

    const { status, body, isServerError, dependency } = mapException(exception, requestId, {
      bodyFields: bodyFieldsOf(request.body),
    });
    const context = { requestId, method: request.method, path: request.originalUrl, userId: request.user?.id };

    if (dependency) {
      this.logger.warn({ err: exception, ...context, dependency }, `Dependency unavailable: ${body.error}`);
      const gate = outageReports.pass(dependency);
      if (gate.pass) {
        Sentry.withScope((scope) => {
          scope.setTags({ requestId: requestId ?? 'none', dependency });
          scope.setExtra('suppressedSinceLastReport', gate.suppressed);
          Sentry.captureException(exception);
        });
      }
    } else if (isServerError) {
      this.logger.error({ err: exception, ...context }, `Unhandled error: ${body.error}`);
      Sentry.withScope((scope) => {
        scope.setTag('requestId', requestId ?? 'none');
        if (request.user) scope.setUser({ id: request.user.id });
        Sentry.captureException(exception);
      });
    } else {
      this.logger.debug({ requestId, errorCode: body.errorCode, error: body.error }, body.errorMessage);
    }

    if (response.headersSent || response.writableEnded || response.destroyed) return;
    if (dependency) response.setHeader('Retry-After', String(OUTAGE_RETRY_AFTER_SECONDS));
    response.status(status).json(body);
  }
}
