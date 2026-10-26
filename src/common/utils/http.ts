import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';

/**
 * Status Nest will send for a successful handler. Interceptors run before Nest writes it to
 * the response, so it is resolved from `@HttpCode()` or the method default (POST → 201).
 */
export function resolveSuccessStatus(context: ExecutionContext): HttpStatus {
  const explicit = Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) as HttpStatus | undefined;
  if (explicit) return explicit;
  return context.switchToHttp().getRequest<Request>().method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK;
}
