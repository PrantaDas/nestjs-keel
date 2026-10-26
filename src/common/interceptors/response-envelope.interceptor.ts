import { CallHandler, ExecutionContext, HttpStatus, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, Observable } from 'rxjs';
import { RESPONSE_MESSAGE_KEY, SKIP_ENVELOPE_KEY } from '@/common/decorators/response.decorators';
import { PaginatedObject, PaginatedResult, PaginationMeta } from '@/common/dto/pagination.dto';
import { resolveSuccessStatus } from '@/common/utils/http';

/** Fallback only; routes declare `@ResponseMessage('Note created.')`. */
export const DEFAULT_SUCCESS_MESSAGE = 'Done.';

export interface SuccessEnvelope<T> {
  success: true;
  message: string;
  data: T;
  meta?: PaginationMeta;
}

/** Wraps every HTTP success in `{ success, message, data, meta? }`. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_ENVELOPE_KEY, targets)) return next.handle();

    // Every enveloped route sets its own message (guarded by test/unit/api-messages.spec.ts).
    const message = this.reflector.getAllAndOverride<string>(RESPONSE_MESSAGE_KEY, targets) ?? DEFAULT_SUCCESS_MESSAGE;
    const isNoContent = resolveSuccessStatus(context) === HttpStatus.NO_CONTENT;

    return next.handle().pipe(
      map((result: unknown) => {
        if (isNoContent || result instanceof StreamableFile) return result;
        if (result instanceof PaginatedResult) {
          return { success: true, message, data: result.items, meta: result.meta } satisfies SuccessEnvelope<unknown>;
        }
        if (result instanceof PaginatedObject) {
          return { success: true, message, data: result.data, meta: result.meta } satisfies SuccessEnvelope<unknown>;
        }
        return { success: true, message, data: result ?? null } satisfies SuccessEnvelope<unknown>;
      }),
    );
  }
}
