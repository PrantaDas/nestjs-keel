import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { catchError, Observable, tap, throwError } from 'rxjs';
import { Role } from '@/common/auth/auth.types';
import { RequestContext } from '@/common/context/request-context';
import { mapException } from '@/common/exceptions/exception-mapper';
import { resolveSuccessStatus } from '@/common/utils/http';
import { sanitizeForLog } from '@/common/utils/sanitize';
import { AUDIT_KEY, AuditOptions } from '@/common/decorators/audit.decorator';
import { AuditOutcome } from './schemas/audit-log.schema';
import { AuditService } from './audit.service';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Staff roles whose actions are audited. End users are never audited (volume, privacy). */
const AUDITED_ROLES = new Set<string>([Role.SUPER_ADMIN, Role.ADMIN]);

/**
 * Records every write by staff (admin / super admin), plus staff reads on routes marked
 * `@Audit(...)`, with request details, outcome and before/after snapshots.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const options = this.reflector.get<AuditOptions | undefined>(AUDIT_KEY, context.getHandler());
    const isStaff = request.user !== undefined && AUDITED_ROLES.has(request.user.role);
    if (!isStaff || (!options && !WRITE_METHODS.has(request.method))) return next.handle();

    const startedAt = performance.now();
    const write = (outcome: AuditOutcome, statusCode: number, errorCode?: number) =>
      this.write(request, options, {
        outcome,
        statusCode,
        errorCode,
        durationMs: Math.round(performance.now() - startedAt),
      });

    return next.handle().pipe(
      tap(() => write('success', resolveSuccessStatus(context))),
      catchError((error: unknown) => {
        const { status, body } = mapException(error);
        write('failure', status, body.errorCode);
        return throwError(() => error);
      }),
    );
  }

  private write(
    request: Request,
    options: AuditOptions | undefined,
    result: { outcome: AuditOutcome; statusCode: number; errorCode?: number; durationMs: number },
  ): void {
    const user = request.user!;
    const route = (request.route as { path?: string } | undefined)?.path ?? request.path;
    const snapshot = RequestContext.current()?.audit ?? {};
    const params = request.params as Record<string, string>;

    this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: options?.action ?? `${request.method} ${route}`,
      resource: options?.resource,
      resourceId: snapshot.resourceId ?? params[options?.resourceIdParam ?? 'id'],
      method: request.method,
      route,
      url: request.originalUrl,
      ...result,
      params: sanitizeForLog(params) as Record<string, unknown>,
      query: sanitizeForLog(request.query) as Record<string, unknown>,
      body: sanitizeForLog(request.body),
      before: sanitizeForLog(snapshot.before),
      after: sanitizeForLog(snapshot.after),
      metadata: snapshot.metadata,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      requestId: RequestContext.requestId(),
    });
  }
}
