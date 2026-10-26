import { ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { RequestErrors, RequestException } from '@/common/exceptions';

/**
 * Rate limit per authenticated user when known, otherwise per client IP
 * (`trust proxy` must be set correctly for `req.ip` to be the real client). Works for REST and
 * GraphQL over HTTP; GraphQL subscriptions (no HTTP response) are not throttled here.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override getRequestResponse(context: ExecutionContext): {
    req: Record<string, unknown>;
    res: Record<string, unknown>;
  } {
    if (context.getType<string>() === 'graphql') {
      const { req, res } = GqlExecutionContext.create(context).getContext<{
        req: Record<string, unknown>;
        res?: Record<string, unknown>;
      }>();
      return { req, res: res ?? { header: () => undefined, setHeader: () => undefined } };
    }
    return super.getRequestResponse(context);
  }

  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as Request;
    return Promise.resolve(request.user ? `user:${request.user.id}` : `ip:${request.ip}`);
  }

  protected override throwThrottlingException(_context: ExecutionContext): Promise<void> {
    throw new RequestException(RequestErrors.RATE_LIMITED);
  }
}
