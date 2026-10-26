import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { DEPRECATED_KEY, DeprecationOptions } from '@/common/decorators/deprecated.decorator';
import { RequestErrors, RequestException } from '@/common/exceptions';
import { TimeService } from '@/common/time/time.service';

/** `2027-06-30` → that day at 00:00 UTC. */
const utcDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** Adds the deprecation headers of `@Deprecated()` routes and retires them after their sunset day. */
@Injectable()
export class DeprecationInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly time: TimeService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const options = this.reflector.getAllAndOverride<DeprecationOptions | undefined>(DEPRECATED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return next.handle();

    const sunset = utcDay(options.sunset);
    if (this.time.now() >= sunset) throw new RequestException(RequestErrors.ENDPOINT_RETIRED);

    const response = context.switchToHttp().getResponse<Response>();
    const since = options.since ? utcDay(options.since) : undefined;
    response.setHeader('Deprecation', since ? `@${Math.floor(since.getTime() / 1000)}` : 'true');
    response.setHeader('Sunset', sunset.toUTCString());
    if (options.successor) response.setHeader('Link', `<${options.successor}>; rel="successor-version"`);
    return next.handle();
  }
}
