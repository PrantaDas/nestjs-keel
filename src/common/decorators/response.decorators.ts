import { SetMetadata } from '@nestjs/common';

export const RESPONSE_MESSAGE_KEY = 'response:message';
export const SKIP_ENVELOPE_KEY = 'response:skipEnvelope';

/** Human-readable `message` placed in the success envelope. */
export const ResponseMessage = (message: string): MethodDecorator => SetMetadata(RESPONSE_MESSAGE_KEY, message);

/** Returns the handler result as-is (files, streams, third-party webhooks). */
export const SkipEnvelope = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_ENVELOPE_KEY, true);
