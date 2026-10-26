import type { SendOnceStatus } from '@/integrations/resilience/send-once';

export interface SmsMessage {
  /** E.164 with the leading `+`, e.g. `+14155550123`. */
  to: string;
  body: string;
}

/**
 * Outbound SMS. Feature code (OTP delivery) depends on this port; Twilio is bound in
 * `IntegrationsModule`, tests bind a fake. Throws `IntegrationNotConfiguredException` when no SMS
 * provider is configured. Never retried in-process: a send costs money and is not idempotent.
 */
export abstract class SmsSender {
  abstract send(message: SmsMessage, options?: { onceKey?: string }): Promise<SendOnceStatus>;
}
