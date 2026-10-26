import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import twilio from 'twilio';
import { IntegrationNotConfiguredException } from '@/common/exceptions';
import { integrationsConfig, resilienceConfig } from '@/config/configuration';
import { guardedCall } from '@/integrations/resilience/guarded-call';
import { SendOnceGuard, type SendOnceStatus } from '@/integrations/resilience/send-once';
import { timeoutsFrom } from '@/integrations/resilience/settings';
import { SmsMessage, SmsSender } from './sms.port';

const INTEGRATION = 'Twilio SMS';

/**
 * Twilio Programmable Messaging. The app generates and checks its own codes (OtpService), so this
 * only delivers text. Explicit request timeout, client auto-retry off, `twilio` circuit breaker.
 */
@Injectable()
export class TwilioSmsSender extends SmsSender {
  private client?: ReturnType<typeof twilio>;
  private readonly timeoutMs: number;

  constructor(
    @Inject(integrationsConfig.KEY) private readonly config: ConfigType<typeof integrationsConfig>,
    private readonly once: SendOnceGuard,
    @Optional() @Inject(resilienceConfig.KEY) resilience?: ConfigType<typeof resilienceConfig>,
  ) {
    super();
    this.timeoutMs = timeoutsFrom(resilience).twilio;
  }

  async send(message: SmsMessage, options: { onceKey?: string } = {}): Promise<SendOnceStatus> {
    const client = this.twilio();
    const { from } = this.config.twilio;
    // A Messaging Service SID (MG…) picks the sender per destination; otherwise a fixed number.
    const sender = from.startsWith('MG') ? { messagingServiceSid: from } : { from };
    return this.once.run(INTEGRATION, options.onceKey, () =>
      guardedCall(INTEGRATION, () => client.messages.create({ to: message.to, body: message.body, ...sender })),
    );
  }

  private twilio(): ReturnType<typeof twilio> {
    const { accountSid, authToken, from } = this.config.twilio;
    if (!accountSid || !authToken || !from) throw new IntegrationNotConfiguredException(INTEGRATION);
    this.client ??= twilio(accountSid, authToken, { timeout: this.timeoutMs, autoRetry: false });
    return this.client;
  }
}
