import { Processor } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Job } from 'bullmq';
import { appConfig } from '@/config/configuration';
import { BaseProcessor } from '@/infra/queue/base.processor';
import { QueueName } from '@/infra/queue/queue.constants';
import { MailSender } from '@/integrations/mail/mail.port';
import { SmsSender } from '@/integrations/sms/sms.port';
import { OtpService } from './otp.service';
import type { OtpDeliveryJob } from './otp.types';

const SUBJECTS: Record<OtpDeliveryJob['purpose'], string> = {
  login: 'Your sign-in code',
  'verify-email': 'Confirm your email address',
  'reset-password': 'Reset your password',
  'change-email': 'Confirm your new email address',
  'change-phone': 'Confirm your new phone number',
};

/**
 * Sends one code through the SMS or mail port. The send is claimed with the job id before the
 * provider call (`onceKey`), so a retried or duplicated job never sends twice; an ambiguous failure
 * (the provider may have sent it) is not retried and the person can ask for a new code.
 */
@Processor(QueueName.OTP_DELIVERY)
export class OtpDeliveryProcessor extends BaseProcessor<OtpDeliveryJob> {
  constructor(
    private readonly sms: SmsSender,
    private readonly mail: MailSender,
    @Inject(appConfig.KEY) private readonly app: ConfigType<typeof appConfig>,
  ) {
    super();
  }

  protected async handle(job: Job<OtpDeliveryJob>): Promise<void> {
    const text = OtpService.message(this.app.name, job.data);
    const onceKey = `otp-delivery:${job.id}`;
    if (job.data.channel === 'sms') {
      await this.sms.send({ to: job.data.recipient, body: text }, { onceKey });
      return;
    }
    await this.mail.send(
      {
        to: job.data.recipient,
        subject: SUBJECTS[job.data.purpose],
        text,
        html: `<p>${text.replace(job.data.code, `<strong style="font-size:20px;letter-spacing:2px">${job.data.code}</strong>`)}</p>`,
      },
      { onceKey },
    );
  }
}
