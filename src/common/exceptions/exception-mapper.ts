import { HttpException, HttpStatus } from '@nestjs/common';
import { fieldLabel } from '@/common/messages/field-labels';
import { BaseException, ErrorDetail } from './base.exception';
import { Dependency, unavailableDependency } from './dependency-errors';
import { summarizeValidation } from './domain.exceptions';
import { describeDuplicateKey, duplicateKeyError } from './duplicate-keys';
import { AuthErrors, RequestErrors, SystemErrors } from './error-codes';
import { ErrorDefinition } from './error-registry';

export interface ErrorEnvelope {
  success: false;
  errorCode: number;
  error: string;
  errorMessage: string;
  details?: ErrorDetail[];
  requestId?: string;
}

export interface MappedError {
  status: number;
  body: ErrorEnvelope;
  /** 5xx and unknown errors: log with stack and report to Sentry. */
  isServerError: boolean;
  /**
   * Set when the error means a runtime dependency is down or too slow (503). Expected during an
   * outage: logged as a warning and reported to Sentry at most once a minute, not once per request.
   */
  dependency?: Dependency;
}

export interface MapContext {
  /**
   * Top-level fields of the request body the client sent. Errors raised below the validation pipe
   * (duplicate keys, Mongoose casts and validation) only name a field in `details` when it is one of
   * these, so internal schema paths (`titleKey`) never reach a client.
   */
  bodyFields?: readonly string[];
}

const build = (
  definition: ErrorDefinition,
  requestId: string | undefined,
  overrides: { message?: string; details?: ErrorDetail[]; status?: number } = {},
): MappedError => {
  const status = overrides.status ?? definition.status;
  return {
    status,
    isServerError: status >= 500,
    body: {
      success: false,
      errorCode: definition.code,
      error: definition.key,
      errorMessage: overrides.message ?? definition.message,
      ...(overrides.details?.length ? { details: overrides.details } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };
};

const HTTP_STATUS_TO_ERROR: Partial<Record<number, ErrorDefinition>> = {
  [HttpStatus.BAD_REQUEST]: RequestErrors.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: AuthErrors.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: AuthErrors.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: RequestErrors.ROUTE_NOT_FOUND,
  [HttpStatus.METHOD_NOT_ALLOWED]: RequestErrors.METHOD_NOT_ALLOWED,
  [HttpStatus.CONFLICT]: RequestErrors.DUPLICATE_RESOURCE,
  [HttpStatus.PAYLOAD_TOO_LARGE]: RequestErrors.PAYLOAD_TOO_LARGE,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: RequestErrors.UNSUPPORTED_MEDIA_TYPE,
  [HttpStatus.TOO_MANY_REQUESTS]: RequestErrors.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: SystemErrors.SERVICE_UNAVAILABLE,
};

interface MongooseValidatorError {
  path?: string;
  kind?: string;
}

interface ErrorLike {
  name?: string;
  path?: string;
  errors?: Record<string, MongooseValidatorError>;
}

/** Wording for Mongoose schema validators (`kind`), never Mongoose's own "Path `x` is required". */
function mongooseRuleMessage(path: string | undefined, kind: string | undefined): string {
  const label = fieldLabel(path);
  switch (kind) {
    case 'required':
      return `${label} is required.`;
    case 'maxlength':
      return `${label} is too long.`;
    case 'minlength':
      return `${label} is too short.`;
    case 'min':
      return `${label} is too small.`;
    case 'max':
      return `${label} is too large.`;
    case 'enum':
      return `${label} isn't one of the allowed options.`;
    default:
      return `${label} isn't valid.`;
  }
}

/**
 * Converts anything thrown into the public error envelope. Internal messages, stacks, schema paths,
 * index names and dependency names never leave the server (the filters log the original error);
 * unknown errors become a generic INTERNAL_ERROR.
 */
export function mapException(exception: unknown, requestId?: string, context: MapContext = {}): MappedError {
  if (exception instanceof BaseException) {
    return build(
      {
        code: exception.errorCode,
        key: exception.error,
        status: exception.httpStatus,
        message: exception.message,
        domain: exception.domain,
      },
      requestId,
      { details: exception.details },
    );
  }

  const sent = new Set(context.bodyFields ?? []);
  const isSent = (path: string | undefined): path is string => Boolean(path && sent.has(path.split('.')[0]));

  if (exception instanceof HttpException) {
    const status: HttpStatus = exception.getStatus();
    // Framework messages and details (Nest, multer, the throttler, readiness checks) stay in the logs.
    const definition = HTTP_STATUS_TO_ERROR[status];
    if (definition) return build(definition, requestId);
    return build(
      status >= HttpStatus.INTERNAL_SERVER_ERROR ? SystemErrors.INTERNAL_ERROR : RequestErrors.BAD_REQUEST,
      requestId,
      { status },
    );
  }

  // Unique index conflict: a known index gets its own sentence; never the index, key names or values.
  const duplicate = duplicateKeyError(exception);
  if (duplicate) {
    const known = describeDuplicateKey(duplicate);
    return build(RequestErrors.DUPLICATE_RESOURCE, requestId, {
      message: known?.message,
      details: known && isSent(known.field) ? [{ field: known.field, message: known.message }] : undefined,
    });
  }

  const err = (exception ?? {}) as ErrorLike;

  if (err.name === 'CastError') {
    return build(RequestErrors.INVALID_ID, requestId, {
      details: isSent(err.path) ? [{ field: err.path, message: `${fieldLabel(err.path)} isn't valid.` }] : undefined,
    });
  }

  if (err.name === 'ValidationError' && err.errors) {
    const details = Object.values(err.errors)
      .filter((e) => isSent(e.path))
      .map((e) => ({ field: e.path, message: mongooseRuleMessage(e.path, e.kind) }));
    return build(RequestErrors.VALIDATION_FAILED, requestId, {
      details,
      message: details.length ? summarizeValidation(details) : undefined,
    });
  }

  const dependency = unavailableDependency(exception);
  if (dependency) {
    const definition = dependency === 'mongodb' ? SystemErrors.DATABASE_UNAVAILABLE : SystemErrors.REDIS_UNAVAILABLE;
    return { ...build(definition, requestId), dependency };
  }

  return build(SystemErrors.INTERNAL_ERROR, requestId);
}

/** Top-level field names of a parsed JSON / form body (for `MapContext.bodyFields`). */
export function bodyFieldsOf(body: unknown): string[] {
  return body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
}
