import { Inject, Injectable, OnApplicationShutdown, Optional } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { IntegrationNotConfiguredException } from '@/common/exceptions';
import { integrationsConfig, resilienceConfig } from '@/config/configuration';
import { guardedCall } from '@/integrations/resilience/guarded-call';
import { SendOnceGuard, type SendOnceStatus } from '@/integrations/resilience/send-once';
import { timeoutsFrom } from '@/integrations/resilience/settings';
import { MailMessage, MailSender, MailSendOptions } from './mail.port';

const INTEGRATION = 'SMTP';
const CONNECT_TIMEOUT_MS = 10_000;
/** Extra time after the socket timeout before the caller is released regardless. */
const DEADLINE_GRACE_MS = 5_000;

/**
 * SMTP mail through one pooled transporter, created on first use. Connection, greeting and socket
 * timeouts are explicit (nodemailer defaults are minutes), the caller is released after
 * SMTP_TIMEOUT_MS + 5 s, and every send goes through the `smtp` circuit breaker. Sends are not
 * retried in-process (not idempotent); pass `onceKey` to make a job retry safe.
 */
@Injectable()
export class SmtpMailSender extends MailSender implements OnApplicationShutdown {
  private transporter?: Transporter;
  private readonly timeoutMs: number;

  constructor(
    @Inject(integrationsConfig.KEY) private readonly config: ConfigType<typeof integrationsConfig>,
    private readonly once: SendOnceGuard,
    @Optional() @Inject(resilienceConfig.KEY) resilience?: ConfigType<typeof resilienceConfig>,
  ) {
    super();
    this.timeoutMs = timeoutsFrom(resilience).smtp;
  }

  async send(message: MailMessage, options: MailSendOptions = {}): Promise<SendOnceStatus> {
    const transporter = this.client();
    const deliver = () =>
      guardedCall(
        INTEGRATION,
        () =>
          transporter.sendMail({
            from: this.config.smtp.from,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
        { deadlineMs: this.timeoutMs + DEADLINE_GRACE_MS },
      );
    return this.once.run(INTEGRATION, options.onceKey, deliver);
  }

  onApplicationShutdown(): void {
    this.transporter?.close();
  }

  private client(): Transporter {
    const { smtp } = this.config;
    if (!smtp.host) throw new IntegrationNotConfiguredException(INTEGRATION);
    this.transporter ??= createTransport({
      pool: true,
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      // Local catchers (Mailpit) take no credentials.
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: this.timeoutMs,
    });
    return this.transporter;
  }
}
