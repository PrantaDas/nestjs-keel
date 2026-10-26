import { HttpStatus } from '@nestjs/common';
import { ErrorDefinition } from './error-registry';

export interface ErrorDetail {
  field?: string;
  message: string;
  [key: string]: unknown;
}

export interface ExceptionOptions {
  /** Overrides the catalogue message with a more specific, still user-safe one. */
  message?: string;
  details?: ErrorDetail[];
  /** Internal cause; logged, never sent to the client. */
  cause?: unknown;
}

/**
 * Root of every error the app throws on purpose. The global filter turns it into
 * `{ success: false, errorCode, error, errorMessage, details?, requestId }`.
 * Extend it per domain (AuthException, NotesException, ...) instead of throwing it directly.
 */
export abstract class BaseException extends Error {
  readonly errorCode: number;
  readonly error: string;
  readonly httpStatus: HttpStatus;
  readonly domain: string;
  readonly details?: ErrorDetail[];

  protected constructor(definition: ErrorDefinition, options: ExceptionOptions = {}) {
    super(options.message ?? definition.message, { cause: options.cause });
    this.name = new.target.name;
    this.errorCode = definition.code;
    this.error = definition.key;
    this.httpStatus = definition.status;
    this.domain = definition.domain;
    this.details = options.details;
  }
}
