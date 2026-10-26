import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'audit:options';

export interface AuditOptions {
  /** Dotted verb, e.g. `user.disable`. */
  action: string;
  /** Resource type, e.g. `user`. */
  resource?: string;
  /** Route param holding the resource id (default `id`). */
  resourceIdParam?: string;
}

/**
 * Names an audited action (opt-in audit trail, `modules/audit`). Staff writes (POST/PUT/PATCH/DELETE
 * by an admin or super admin) are audited even without it; add it to give the entry a meaningful
 * action name, or to audit a staff read such as a data export. End-user requests are not audited
 * (volume, privacy). Inside the service, `RequestContext.recordAudit({ before, after })` stores the
 * change itself.
 */
export const Audit = (options: AuditOptions): MethodDecorator => SetMetadata(AUDIT_KEY, options);
