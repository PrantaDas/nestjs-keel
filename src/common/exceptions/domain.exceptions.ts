import { BaseException, ErrorDetail, ExceptionOptions } from './base.exception';
import { AuthErrors, RequestErrors, SystemErrors } from './error-codes';
import { ErrorDefinition } from './error-registry';

// ── Domain bases ────────────────────────────────────────────────────────────

export class AuthException extends BaseException {
  constructor(definition: ErrorDefinition = AuthErrors.UNAUTHENTICATED, options?: ExceptionOptions) {
    super(definition, options);
  }
}

export class RequestException extends BaseException {
  constructor(definition: ErrorDefinition = RequestErrors.BAD_REQUEST, options?: ExceptionOptions) {
    super(definition, options);
  }
}

export class SystemException extends BaseException {
  constructor(definition: ErrorDefinition = SystemErrors.INTERNAL_ERROR, options?: ExceptionOptions) {
    super(definition, options);
  }
}

// ── Common concrete cases ───────────────────────────────────────────────────

export class ForbiddenActionException extends AuthException {
  constructor(message?: string) {
    super(AuthErrors.FORBIDDEN, { message });
  }
}

export class ValidationException extends RequestException {
  constructor(details: ErrorDetail[], message?: string) {
    super(RequestErrors.VALIDATION_FAILED, { details, message: message ?? summarizeValidation(details) });
  }
}

export class ResourceNotFoundException extends RequestException {
  /** @param resource Human name, e.g. `Note` → "Note not found." */
  constructor(resource?: string) {
    super(RequestErrors.RESOURCE_NOT_FOUND, { message: resource ? `${resource} not found.` : undefined });
  }
}

export class DuplicateResourceException extends RequestException {
  constructor(message?: string, details?: ErrorDetail[]) {
    super(RequestErrors.DUPLICATE_RESOURCE, { message, details });
  }
}

/**
 * What people call the thing an integration does, for messages ("the email service"). Provider and
 * product names (Twilio, Firebase, S3, Stripe, …) stay in logs: `integration` is kept on the exception.
 */
const SERVICE_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/s3|storage/i, 'file storage service'],
  [/twilio|sms|otp/i, 'text message service'],
  [/firebase|fcm|push/i, 'notification service'],
  [/smtp|mail/i, 'email service'],
  [/stripe|payment/i, 'payment service'],
  [/grpc|rabbit|transport/i, 'internal service'],
];

/** Human name of an integration's service: `'Twilio SMS'` → "text message service". */
export function serviceName(integration: string): string {
  return SERVICE_NAMES.find(([pattern]) => pattern.test(integration))?.[1] ?? 'outside service';
}

export class IntegrationNotConfiguredException extends SystemException {
  constructor(readonly integration: string) {
    super(SystemErrors.INTEGRATION_NOT_CONFIGURED, {
      message: `The ${serviceName(integration)} isn't set up yet, so this can't be done right now. Please contact support.`,
    });
  }
}

export class IntegrationFailedException extends SystemException {
  constructor(
    readonly integration: string,
    cause?: unknown,
  ) {
    super(SystemErrors.INTEGRATION_FAILED, {
      message: `The ${serviceName(integration)} didn't respond properly. Please try again in a moment.`,
      cause,
    });
  }
}

/**
 * `errorMessage` for a validation failure: the message itself when there is one problem, otherwise a
 * pointer to the fields (each has its own message in `details`).
 */
export function summarizeValidation(details: readonly ErrorDetail[]): string {
  if (details.length === 0) return RequestErrors.VALIDATION_FAILED.message;
  if (details.length === 1) return details[0].message;
  return details.some((detail) => detail.field)
    ? 'Please check the highlighted fields.'
    : RequestErrors.VALIDATION_FAILED.message;
}
