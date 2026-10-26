import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { RequestErrors, RequestException } from '@/common/exceptions';

/**
 * Rate limit per authenticated user when known, otherwise per client IP
 * (`trust proxy` must be set correctly for `req.ip` to be the real client).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as Request;
    return Promise.resolve(request.user ? `user:${request.user.id}` : `ip:${request.ip}`);
  }

  protected override throwThrottlingException(_context: ExecutionContext): Promise<void> {
    throw new RequestException(RequestErrors.RATE_LIMITED);
  }
}
