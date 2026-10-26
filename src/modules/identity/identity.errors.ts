import { HttpStatus } from '@nestjs/common';
import {
  BaseException,
  defineDuplicateKeys,
  defineErrors,
  ErrorDefinition,
  ExceptionOptions,
} from '@/common/exceptions';

/** Identity: accounts, sign-in, sessions, codes. Range 3000–3199 (docs/conventions/errors.md). */
export const IdentityErrors = defineErrors('identity', [3000, 3199], {
  EMAIL_TAKEN: {
    code: 3000,
    status: HttpStatus.CONFLICT,
    message: 'An account with this email already exists. Sign in instead, or use another email.',
  },
  PHONE_TAKEN: {
    code: 3001,
    status: HttpStatus.CONFLICT,
    message: 'This phone number is already used by another account.',
  },
  INVALID_CREDENTIALS: {
    code: 3002,
    status: HttpStatus.UNAUTHORIZED,
    message: 'The email or password is incorrect.',
  },
  ACCOUNT_LOCKED: {
    code: 3003,
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Too many sign-in attempts. Your account is locked for a few minutes, please try again later.',
  },
  ACCOUNT_DEACTIVATED: {
    code: 3004,
    status: HttpStatus.FORBIDDEN,
    message: 'This account is deactivated. Contact support to restore it.',
  },
  INVALID_REFRESH_TOKEN: {
    code: 3005,
    status: HttpStatus.UNAUTHORIZED,
    message: 'Your sign-in has expired. Please sign in again.',
  },
  REFRESH_TOKEN_REUSED: {
    code: 3006,
    status: HttpStatus.UNAUTHORIZED,
    message: 'For your security, this sign-in was ended on every device that used it. Please sign in again.',
  },
  OTP_INVALID: {
    code: 3007,
    status: HttpStatus.BAD_REQUEST,
    message: "That code isn't right or has expired. Check it, or ask for a new one.",
  },
  OTP_TOO_MANY_ATTEMPTS: {
    code: 3008,
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Too many wrong codes. Please ask for a new code.',
  },
  OTP_RESEND_TOO_SOON: {
    code: 3009,
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Please wait a moment before asking for another code.',
  },
  OTP_SEND_LIMIT: {
    code: 3010,
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Too many codes were requested. Please try again in an hour.',
  },
  EMAIL_ALREADY_VERIFIED: {
    code: 3011,
    status: HttpStatus.CONFLICT,
    message: 'Your email address is already verified.',
  },
  CONTACT_UNCHANGED: {
    code: 3012,
    status: HttpStatus.BAD_REQUEST,
    message: 'This is already the address on your account.',
  },
  PASSWORD_INCORRECT: {
    code: 3013,
    status: HttpStatus.BAD_REQUEST,
    message: 'The current password is incorrect.',
  },
  USER_NOT_FOUND: {
    code: 3014,
    status: HttpStatus.NOT_FOUND,
    message: "We couldn't find that account.",
  },
  SESSION_NOT_FOUND: {
    code: 3015,
    status: HttpStatus.NOT_FOUND,
    message: "We couldn't find that sign-in. It may have ended already.",
  },
  CANNOT_CHANGE_SELF: {
    code: 3016,
    status: HttpStatus.FORBIDDEN,
    message: "You can't change the role of, or disable, your own account.",
  },
  ROLE_CHANGE_FORBIDDEN: {
    code: 3017,
    status: HttpStatus.FORBIDDEN,
    message: 'Only a super admin can change roles or manage other admins.',
  },
  LAST_SUPER_ADMIN: {
    code: 3018,
    status: HttpStatus.CONFLICT,
    message: "The last super admin can't be demoted or disabled. Make someone else a super admin first.",
  },
  AVATAR_UPLOAD_MISSING: {
    code: 3019,
    status: HttpStatus.BAD_REQUEST,
    message: "We couldn't find the uploaded picture. Please upload it again.",
  },
  DELETION_NOT_PENDING: {
    code: 3020,
    status: HttpStatus.CONFLICT,
    message: 'There is no pending account deletion to cancel.',
  },
  ACCOUNT_DELETION_PENDING: {
    code: 3021,
    status: HttpStatus.CONFLICT,
    message: 'This account is already scheduled for deletion.',
  },
});

export class IdentityException extends BaseException {
  constructor(definition: ErrorDefinition, options?: ExceptionOptions) {
    super(definition, options);
  }
}

// Unique indexes whose conflict can reach the global mapper (two sign-ups racing on one email).
defineDuplicateKeys('users', [
  { fields: ['email'], field: 'email', message: IdentityErrors.EMAIL_TAKEN.message },
  { fields: ['phone'], field: 'phone', message: IdentityErrors.PHONE_TAKEN.message },
]);
