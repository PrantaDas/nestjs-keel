import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from '@/common/auth/auth.types';
import { systemClock } from '@/common/time/clock';
import type { TimeZone } from '@/common/time/time.types';
import { normalizeTimeZone } from '@/common/time/zoned-time';

export interface AuditSnapshot {
  before?: unknown;
  after?: unknown;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface RequestStore {
  requestId: string;
  ip?: string;
  userAgent?: string;
  user?: AuthUser;
  /** Device zone from the `X-Timezone` header (validated IANA name), if sent. */
  timeZone?: TimeZone;
  /** Preferred language from `Accept-Language` (first tag, e.g. `en-GB`), if sent. */
  locale?: string;
  audit: AuditSnapshot;
}

const storage = new AsyncLocalStorage<RequestStore>();
const REQUEST_ID_HEADER = 'x-request-id';
const TIMEZONE_HEADER = 'x-timezone';
const SERVER_TIME_HEADER = 'x-server-time';
const SAFE_REQUEST_ID = /^[\w.-]{8,128}$/;

/**
 * Per-request state that any layer can read without threading it through calls:
 * request id (logs, Sentry, error envelope), the authenticated user, the device timezone, the
 * locale and audit snapshots.
 */
export const RequestContext = {
  current(): RequestStore | undefined {
    return storage.getStore();
  },

  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },

  user(): AuthUser | undefined {
    return storage.getStore()?.user;
  },

  /** Device timezone sent by the app; undefined when absent or invalid. */
  timeZone(): TimeZone | undefined {
    return storage.getStore()?.timeZone;
  },

  locale(): string | undefined {
    return storage.getStore()?.locale;
  },

  setUser(user: AuthUser): void {
    const store = storage.getStore();
    if (store) store.user = user;
  },

  /** Services call this so the audit log can store before/after state of a change. */
  recordAudit(snapshot: AuditSnapshot): void {
    const store = storage.getStore();
    if (store) Object.assign(store.audit, snapshot);
  },

  run<T>(store: RequestStore, fn: () => T): T {
    return storage.run(store, fn);
  },

  /** Express middleware; registered first so everything downstream sees the context. */
  middleware(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const requestId = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();

    req.id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    // Clients base countdowns on server time, never on the (user-adjustable) device clock.
    res.setHeader(SERVER_TIME_HEADER, systemClock.now().toISOString());

    // An invalid zone is ignored (falls back to the stored / business zone), never fatal.
    const timeZone = normalizeTimeZone(req.headers[TIMEZONE_HEADER]) ?? undefined;

    const locale = parseLocale(req.headers['accept-language']);

    storage.run({ requestId, ip: req.ip, userAgent: req.headers['user-agent'], timeZone, locale, audit: {} }, () =>
      next(),
    );
  },
};

/** First language tag of an `Accept-Language` header (`en-GB,en;q=0.9` → `en-GB`), if well formed. */
export function parseLocale(header: string | undefined): string | undefined {
  const tag = header?.split(',')[0]?.split(';')[0]?.trim();
  return tag && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag) ? tag : undefined;
}
