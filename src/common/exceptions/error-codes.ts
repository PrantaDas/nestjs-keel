import { HttpStatus } from '@nestjs/common';
import { defineErrors } from './error-registry';

/**
 * Code ranges:
 *   1000–1999  auth / session / device
 *   2000–2999  request / validation / rate limit
 *   3000–8999  feature domains (each module declares its own range in `<module>.errors.ts`)
 *   9000–9999  system / infrastructure / third-party
 */

export const AuthErrors = defineErrors('auth', [1000, 1999], {
  MISSING_BEARER_TOKEN: {
    code: 1000,
    status: HttpStatus.UNAUTHORIZED,
    message: 'Please sign in to continue.',
  },
  INVALID_TOKEN: {
    code: 1001,
    status: HttpStatus.UNAUTHORIZED,
    message: 'Your sign-in is no longer valid. Please sign in again.',
  },
  TOKEN_EXPIRED: {
    code: 1002,
    status: HttpStatus.UNAUTHORIZED,
    message: 'Your session has expired. Please sign in again.',
  },
  FORBIDDEN: {
    code: 1003,
    status: HttpStatus.FORBIDDEN,
    message: "You don't have permission to do this.",
  },
  UNAUTHENTICATED: {
    code: 1004,
    status: HttpStatus.UNAUTHORIZED,
    message: 'Please sign in to continue.',
  },
});

export const RequestErrors = defineErrors('request', [2000, 2999], {
  VALIDATION_FAILED: {
    code: 2000,
    status: HttpStatus.BAD_REQUEST,
    message: "Some of the details aren't valid. Please check them and try again.",
  },
  BAD_REQUEST: {
    code: 2001,
    status: HttpStatus.BAD_REQUEST,
    message: "We couldn't process this request. Please check it and try again.",
  },
  MALFORMED_JSON: {
    code: 2002,
    status: HttpStatus.BAD_REQUEST,
    message: "We couldn't read what was sent. Please try again.",
  },
  INVALID_ID: {
    code: 2003,
    status: HttpStatus.BAD_REQUEST,
    message: "This link isn't valid. Please check it and try again.",
  },
  ROUTE_NOT_FOUND: {
    code: 2004,
    status: HttpStatus.NOT_FOUND,
    message: "We couldn't find that. Please check the address, or update the app if it's out of date.",
  },
  RESOURCE_NOT_FOUND: {
    code: 2005,
    status: HttpStatus.NOT_FOUND,
    message: "We couldn't find what you were looking for.",
  },
  DUPLICATE_RESOURCE: {
    code: 2006,
    status: HttpStatus.CONFLICT,
    message: 'This already exists. Change it and try again.',
  },
  PAYLOAD_TOO_LARGE: {
    code: 2007,
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    message: 'What you sent is too large. Please make it smaller and try again.',
  },
  RATE_LIMITED: {
    code: 2008,
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: "You're going a little fast. Please wait a moment and try again.",
  },
  METHOD_NOT_ALLOWED: {
    code: 2009,
    status: HttpStatus.METHOD_NOT_ALLOWED,
    message: "This action isn't available here.",
  },
  UNSUPPORTED_MEDIA_TYPE: {
    code: 2010,
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    message: "This type of content isn't supported. Please try again from the app or the admin panel.",
  },
  IDEMPOTENCY_IN_PROGRESS: {
    code: 2012,
    status: HttpStatus.CONFLICT,
    message: 'This request is still being processed. Please wait a moment before trying again.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    code: 2013,
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'This request reference was already used with different details. Send a new reference.',
  },
  INVALID_IDEMPOTENCY_KEY: {
    code: 2014,
    status: HttpStatus.BAD_REQUEST,
    message: "The request reference isn't valid. Use 8 to 128 letters, digits, dashes or underscores.",
  },
  ENDPOINT_RETIRED: {
    code: 2015,
    status: HttpStatus.GONE,
    message: 'This version of the app is no longer supported. Please update the app.',
  },
  /** The client hung up before its request was read (nginx's 499). Nobody receives it; logs only. */
  CLIENT_CLOSED_REQUEST: {
    code: 2011,
    status: 499 as HttpStatus,
    message: 'The request was cancelled before it finished.',
  },
});

export const SystemErrors = defineErrors('system', [9000, 9999], {
  INTERNAL_ERROR: {
    code: 9000,
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'Something went wrong on our side. Please try again in a moment.',
  },
  SERVICE_UNAVAILABLE: {
    code: 9001,
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'Our service is busy right now. Please try again in a moment.',
  },
  INTEGRATION_NOT_CONFIGURED: {
    code: 9002,
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: "This feature isn't set up yet, so it can't be used right now. Please contact support.",
  },
  INTEGRATION_FAILED: {
    code: 9003,
    status: HttpStatus.BAD_GATEWAY,
    message: "We couldn't complete this right now. Please try again in a moment.",
  },
  LOCK_NOT_ACQUIRED: {
    code: 9004,
    status: HttpStatus.CONFLICT,
    message: 'Someone else is updating this right now. Please try again in a moment.',
  },
  // 9100–9102: runtime dependencies and request timeout (docs/architecture/fault-tolerance.md); 9150–9199 belong to
  // the integration layer (src/integrations/resilience/failure.ts). Clients retry later.
  DATABASE_UNAVAILABLE: {
    code: 9100,
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'Our service is busy right now. Please try again in a moment.',
  },
  REDIS_UNAVAILABLE: {
    code: 9101,
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'Our service is busy right now. Please try again in a moment.',
  },
  REQUEST_TIMEOUT: {
    code: 9102,
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'This is taking longer than usual. Please try again in a moment.',
  },
});
