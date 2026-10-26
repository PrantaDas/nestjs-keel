import { HttpStatus } from '@nestjs/common';
import { AuthException, defineErrors, ErrorDefinition, ExceptionOptions } from '@/common/exceptions';

/** Errors raised while authorising a request (guard, access validator, API keys). Range 1100–1199. */
export const AccessErrors = defineErrors('auth-access', [1100, 1199], {
  SESSION_REVOKED: {
    code: 1100,
    status: HttpStatus.UNAUTHORIZED,
    message: 'Your session has ended. Please sign in again.',
  },
  ACCOUNT_DISABLED: {
    code: 1101,
    status: HttpStatus.UNAUTHORIZED,
    message: 'This account is disabled. Please contact support.',
  },
  INVALID_API_KEY: {
    code: 1102,
    status: HttpStatus.UNAUTHORIZED,
    message: 'The service credentials are missing or not valid.',
  },
});

/** An AuthException so clients treat it like any other 401/403 from the guard. */
export class AccessException extends AuthException {
  constructor(definition: ErrorDefinition, options?: ExceptionOptions) {
    super(definition, options);
  }
}
