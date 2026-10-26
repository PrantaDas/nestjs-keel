import type { SendOnceStatus } from '@/integrations/resilience/send-once';

export interface MailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export interface MailSendOptions {
  /** Idempotency key (e.g. `welcome:<userId>`): claimed before the SMTP call, never sent twice. */
  onceKey?: string;
}

/**
 * Outbound e-mail. Feature code depends on this port; the SMTP implementation is bound in
 * `IntegrationsModule` and tests bind a fake. Throws `IntegrationNotConfiguredException` when no
 * mail server is configured.
 */
export abstract class MailSender {
  abstract send(message: MailMessage, options?: MailSendOptions): Promise<SendOnceStatus>;
}
