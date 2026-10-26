import { HttpStatus } from '@nestjs/common';
import {
  BaseException,
  defineErrors,
  IntegrationFailedException,
  IntegrationNotConfiguredException,
  serviceName,
  SystemErrors,
  SystemException,
} from '@/common/exceptions';

/**
 * Errors of the integration layer (9150–9199, next to the system range): the circuit breaker's
 * fail-fast answer and the "sent, but not confirmed" outcome of a claimed send.
 */
export const IntegrationErrors = defineErrors('integrations', [9150, 9199], {
  INTEGRATION_UNAVAILABLE: {
    code: 9150,
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'One of our services is busy right now. Please try again in a moment.',
  },
  INTEGRATION_OUTCOME_UNKNOWN: {
    code: 9151,
    status: HttpStatus.BAD_GATEWAY,
    message: "We couldn't confirm that this went through, so it wasn't repeated. Please check before trying again.",
  },
});

/** How a failed outbound call should be treated. */
export interface FailureClass {
  /** Trying again later can succeed (network, timeout, 429, 5xx, overload). False = same input, same answer. */
  transient: boolean;
  /**
   * The provider may have acted on the request although we saw an error (timeout, connection
   * dropped mid-request, 500/504). A non-idempotent send must then never be repeated.
   */
  ambiguous: boolean;
  /** Short, log-friendly reason: `timeout`, `http_503`, `ECONNREFUSED`, `grpc_14`, … */
  reason: string;
}

/**
 * A classified outbound failure. Extends IntegrationFailedException, so callers that already catch
 * that (and the error envelope: 502 INTEGRATION_FAILED) keep working.
 */
export class IntegrationCallException extends IntegrationFailedException {
  readonly transient: boolean;
  readonly ambiguous: boolean;
  readonly reason: string;

  constructor(integration: string, failure: FailureClass, cause?: unknown) {
    super(integration, cause);
    this.transient = failure.transient;
    this.ambiguous = failure.ambiguous;
    this.reason = failure.reason;
  }

  /** Read by BaseProcessor: a permanent failure ends the job at once (no BullMQ retry). */
  get retryable(): boolean {
    return this.transient;
  }
}

/** The integration's circuit is open: the call was not made (fail fast). Retrying later can succeed. */
export class IntegrationUnavailableException extends SystemException {
  readonly retryable = true;

  constructor(
    readonly integration: string,
    readonly retryAfterMs: number,
  ) {
    super(IntegrationErrors.INTEGRATION_UNAVAILABLE, {
      message: `The ${serviceName(integration)} is busy right now. Please try again in a moment.`,
    });
  }
}

/**
 * A claimed, non-idempotent send failed ambiguously (or a previous attempt did): the provider may
 * have delivered it, so it is not repeated. Never retried automatically.
 */
export class IntegrationOutcomeUnknownException extends SystemException {
  readonly retryable = false;

  constructor(
    readonly integration: string,
    cause?: unknown,
  ) {
    super(IntegrationErrors.INTEGRATION_OUTCOME_UNKNOWN, { cause });
  }
}

const TIMEOUT: FailureClass = { transient: true, ambiguous: true, reason: 'timeout' };

/** Connection never established: the request cannot have reached the provider. */
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNECTION', // nodemailer: could not connect
  'EDNS', // nodemailer: DNS lookup failed
  'CERT_HAS_EXPIRED',
]);

/** Connection lost or timed out after the request may have been written. */
const MID_REQUEST_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
  'ESOCKET', // nodemailer: socket error
  'ESTREAM', // nodemailer: stream error mid-message
]);

/** Errors the SMTP server / client report for a bad message or bad credentials. */
const PERMANENT_CODES = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGE', 'EOAUTH2', 'ERR_INVALID_URL']);

/** gRPC status codes (grpc-js). */
const GRPC: Record<number, FailureClass> = {
  1: { transient: true, ambiguous: true, reason: 'grpc_1_cancelled' },
  2: { transient: true, ambiguous: true, reason: 'grpc_2_unknown' },
  4: { transient: true, ambiguous: true, reason: 'grpc_4_deadline_exceeded' },
  8: { transient: true, ambiguous: false, reason: 'grpc_8_resource_exhausted' },
  10: { transient: true, ambiguous: true, reason: 'grpc_10_aborted' },
  13: { transient: true, ambiguous: true, reason: 'grpc_13_internal' },
  14: { transient: true, ambiguous: false, reason: 'grpc_14_unavailable' },
};

/** Firebase Admin codes that mean "FCM is struggling", not "your message is wrong". */
const FIREBASE_TRANSIENT: Record<string, boolean> = {
  'messaging/internal-error': true,
  'messaging/server-unavailable': false,
  'messaging/unknown-error': true,
  'messaging/quota-exceeded': false,
  'messaging/message-rate-exceeded': false,
  'messaging/device-message-rate-exceeded': false,
  'messaging/topics-message-rate-exceeded': false,
  'app/network-timeout': true,
  'app/network-error': true,
};

/** AWS SDK error names that are worth retrying. */
const AWS_TRANSIENT_NAMES = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'ThrottlingException',
  'Throttling',
  'SlowDown',
  'TooManyRequestsException',
  'InternalError',
  'ServiceUnavailable',
  'NetworkingError',
]);

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  responseCode?: unknown;
  cause?: unknown;
  $retryable?: unknown;
  $fault?: unknown;
  $metadata?: { httpStatusCode?: unknown };
  response?: { status?: unknown };
}

/** HTTP status → class. 502/503/429/408 never reached the application; 500/504 may have. */
export function classifyHttpStatus(status: number): FailureClass {
  const reason = `http_${status}`;
  if (status === 408 || status === 429) return { transient: true, ambiguous: false, reason };
  if (status === 502 || status === 503) return { transient: true, ambiguous: false, reason };
  if (status === 501 || status === 505) return { transient: false, ambiguous: false, reason };
  if (status >= 500) return { transient: true, ambiguous: true, reason };
  if (status >= 400) return { transient: false, ambiguous: false, reason };
  return { transient: true, ambiguous: true, reason };
}

/**
 * Classifies any error thrown by an outbound call (fetch/undici, AWS SDK, firebase-admin, gRPC,
 * nodemailer, Twilio, or our own integration exceptions). Unknown errors are treated as transient
 * and ambiguous: safe for idempotent calls (retry), and a claimed send is never repeated.
 */
export function classifyFailure(error: unknown, depth = 0): FailureClass {
  if (error instanceof IntegrationCallException) {
    return { transient: error.transient, ambiguous: error.ambiguous, reason: error.reason };
  }
  if (error instanceof IntegrationUnavailableException) {
    return { transient: true, ambiguous: false, reason: 'circuit_open' };
  }
  if (error instanceof IntegrationOutcomeUnknownException) {
    return { transient: false, ambiguous: true, reason: 'outcome_unknown' };
  }
  if (error instanceof IntegrationNotConfiguredException) {
    return { transient: false, ambiguous: false, reason: 'not_configured' };
  }
  if (error instanceof IntegrationFailedException) {
    // Bare (unclassified) integration error: the provider answered with an error we did not
    // inspect. Retry-safe, nothing suggests it was acted on.
    if (error.cause === undefined || depth > 3) return { transient: true, ambiguous: false, reason: 'unclassified' };
    return classifyFailure(error.cause, depth + 1);
  }
  if (!error || typeof error !== 'object') return { transient: true, ambiguous: true, reason: 'unknown' };

  const e = error as ErrorLike;
  const name = typeof e.name === 'string' ? e.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return TIMEOUT;

  // nodemailer: SMTP reply codes (4xx temporary, 5xx permanent; the message was not accepted).
  if (typeof e.responseCode === 'number') {
    const transient = e.responseCode >= 400 && e.responseCode < 500;
    return { transient, ambiguous: false, reason: `smtp_${e.responseCode}` };
  }

  if (typeof e.code === 'string') {
    if (e.code in FIREBASE_TRANSIENT) {
      return { transient: true, ambiguous: FIREBASE_TRANSIENT[e.code], reason: e.code };
    }
    if (e.code.startsWith('messaging/') || e.code.startsWith('app/')) {
      return { transient: false, ambiguous: false, reason: e.code };
    }
    if (CONNECT_CODES.has(e.code)) return { transient: true, ambiguous: false, reason: e.code };
    if (MID_REQUEST_CODES.has(e.code)) return { transient: true, ambiguous: true, reason: e.code };
    if (PERMANENT_CODES.has(e.code)) return { transient: false, ambiguous: false, reason: e.code };
  }

  const status = httpStatusOf(e);
  if (status !== null) return classifyHttpStatus(status);

  if (typeof e.code === 'number' && Number.isInteger(e.code) && e.code > 0 && e.code <= 16) {
    return GRPC[e.code] ?? { transient: false, ambiguous: false, reason: `grpc_${e.code}` };
  }

  if (AWS_TRANSIENT_NAMES.has(name) || e.$retryable) return { transient: true, ambiguous: true, reason: name || 'aws' };
  if (e.$fault === 'client') return { transient: false, ambiguous: false, reason: name || 'aws_client' };

  // fetch: `TypeError: fetch failed` with the socket error as `cause`.
  if (e.cause !== undefined && depth <= 3) {
    const inner = classifyFailure(e.cause, depth + 1);
    if (inner.reason !== 'unknown') return inner;
  }
  return { transient: true, ambiguous: true, reason: 'unknown' };
}

function httpStatusOf(e: ErrorLike): number | null {
  for (const value of [e.$metadata?.httpStatusCode, e.status, e.statusCode, e.response?.status]) {
    if (typeof value === 'number' && value >= 100 && value <= 599) return value;
  }
  return null;
}

/** Turns anything an SDK throws into a classified integration exception (domain errors pass through). */
export function toIntegrationError(integration: string, error: unknown): BaseException {
  if (error instanceof BaseException) return error;
  return new IntegrationCallException(integration, classifyFailure(error), error);
}

/**
 * True when retrying the same work later can succeed: open circuit, transient provider errors,
 * timeouts. False for permanent provider answers, missing configuration and unknown outcomes.
 * Non-integration errors are not judged here (false).
 */
export function isTransientIntegrationFailure(error: unknown): boolean {
  if (error instanceof IntegrationUnavailableException) return true;
  if (error instanceof IntegrationFailedException) return classifyFailure(error).transient;
  return false;
}

/** True for errors a retry cannot fix: permanent provider answers, missing config, unknown outcome. */
export function isPermanentIntegrationFailure(error: unknown): boolean {
  if (error instanceof IntegrationNotConfiguredException) return true;
  if (error instanceof IntegrationOutcomeUnknownException) return true;
  if (error instanceof IntegrationFailedException) return !classifyFailure(error).transient;
  return false;
}

/** True for INTEGRATION_NOT_CONFIGURED (also when re-thrown across module boundaries). */
export function isNotConfigured(error: unknown): boolean {
  return error instanceof BaseException && error.errorCode === SystemErrors.INTEGRATION_NOT_CONFIGURED.code;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***'],
  [/(Basic\s+)[A-Za-z0-9+/=]{8,}/gi, '$1***'],
  [
    /((?:api[_-]?key|authkey|auth[_-]?token|access[_-]?key|secret|password|token|key)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
    '$1***',
  ],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key]'],
];

/**
 * Removes anything that looks like a credential (bearer/basic tokens, `key=…`, `token: …`, PEM
 * keys) from provider text before it is logged, stored or shown, and caps its length.
 */
export function redactSecrets(text: string, maxLength = 500): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out.length > maxLength ? `${out.slice(0, maxLength - 1)}…` : out;
}
