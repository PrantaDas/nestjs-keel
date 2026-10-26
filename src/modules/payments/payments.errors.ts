import { HttpStatus } from '@nestjs/common';
import {
  BaseException,
  defineDuplicateKeys,
  defineErrors,
  ErrorDefinition,
  ExceptionOptions,
} from '@/common/exceptions';

/** Payments. Range 6000–6099. */
export const PaymentsErrors = defineErrors('payments', [6000, 6099], {
  PRICE_NOT_FOUND: {
    code: 6000,
    status: HttpStatus.NOT_FOUND,
    message: "This plan or product isn't available anymore. Choose another one.",
  },
  NO_BILLING_ACCOUNT: {
    code: 6001,
    status: HttpStatus.CONFLICT,
    message: "You don't have any purchases or subscriptions to manage yet.",
  },
  WRONG_PRICE_TYPE: {
    code: 6002,
    status: HttpStatus.BAD_REQUEST,
    message: "This plan can't be bought this way. Use the subscription checkout for recurring plans.",
  },
});

export class PaymentsException extends BaseException {
  constructor(definition: ErrorDefinition, options?: ExceptionOptions) {
    super(definition, options);
  }
}

defineDuplicateKeys('billing_customers', [
  { fields: ['userId'], message: 'Your billing account is being set up. Please try again in a moment.' },
]);
