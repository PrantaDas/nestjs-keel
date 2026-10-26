import { Global, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { resilienceConfig } from '@/config/configuration';
import { MailSender } from './mail/mail.port';
import { SmtpMailSender } from './mail/smtp-mail.sender';
import { FcmPushSender } from './push/fcm-push.sender';
import { PushSender } from './push/push.port';
import { VapidWebPushSender } from './push/vapid-web-push.sender';
import { WebPushSender } from './push/web-push.port';
import { CircuitBreakerRegistry, integrationBreakers } from './resilience/circuit-breaker';
import { SendOnceGuard } from './resilience/send-once';
import { breakerSettingsFrom, setDefaultHttpTimeoutMs, timeoutsFrom } from './resilience/settings';
import { SmsSender } from './sms/sms.port';
import { TwilioSmsSender } from './sms/twilio-sms.sender';
import { S3FileStorage } from './storage/s3-file.storage';
import { FileStorage } from './storage/storage.port';

/**
 * Outbound providers, each behind a port (abstract class) so feature code never imports an SDK and
 * tests swap in fakes (`overrideProvider(MailSender)`). Clients are created lazily on first use: a
 * missing credential fails only the feature that needs it (INTEGRATION_NOT_CONFIGURED), never the
 * boot. Every call has a timeout and goes through its integration's circuit breaker (one registry
 * per process, configured here); see docs/conventions/integrations.md. Stripe lives with the
 * payments module, which is the only one that uses it.
 */
@Global()
@Module({
  providers: [
    {
      provide: CircuitBreakerRegistry,
      inject: [resilienceConfig.KEY],
      useFactory: (config: ConfigType<typeof resilienceConfig>) => {
        setDefaultHttpTimeoutMs(timeoutsFrom(config).http);
        return integrationBreakers.configure(breakerSettingsFrom(config));
      },
    },
    SendOnceGuard,
    { provide: FileStorage, useClass: S3FileStorage },
    { provide: MailSender, useClass: SmtpMailSender },
    { provide: SmsSender, useClass: TwilioSmsSender },
    { provide: PushSender, useClass: FcmPushSender },
    { provide: WebPushSender, useClass: VapidWebPushSender },
  ],
  exports: [CircuitBreakerRegistry, SendOnceGuard, FileStorage, MailSender, SmsSender, PushSender, WebPushSender],
})
export class IntegrationsModule {}
