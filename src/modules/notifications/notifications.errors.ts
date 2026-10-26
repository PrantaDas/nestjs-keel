import { HttpStatus } from '@nestjs/common';
import { BaseException, defineErrors, ErrorDefinition, ExceptionOptions } from '@/common/exceptions';

/** Notifications: inbox, devices, sends. Range 4000–4099. */
export const NotificationsErrors = defineErrors('notifications', [4000, 4099], {
  INBOX_ITEM_NOT_FOUND: {
    code: 4000,
    status: HttpStatus.NOT_FOUND,
    message: "We couldn't find that notification.",
  },
  TOO_MANY_RECIPIENTS: {
    code: 4001,
    status: HttpStatus.BAD_REQUEST,
    message: 'Send to at most 10,000 people at once, or use a topic.',
  },
  WEB_PUSH_SERVICE_NOT_SUPPORTED: {
    code: 4002,
    status: HttpStatus.BAD_REQUEST,
    message: "This browser's notification service isn't supported.",
  },
  WEB_PUSH_SUBSCRIPTION_NOT_FOUND: {
    code: 4003,
    status: HttpStatus.NOT_FOUND,
    message: "We couldn't find that browser.",
  },
});

export class NotificationsException extends BaseException {
  constructor(definition: ErrorDefinition, options?: ExceptionOptions) {
    super(definition, options);
  }
}
