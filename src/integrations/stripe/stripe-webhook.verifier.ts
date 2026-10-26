import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import Stripe from 'stripe';
import { IntegrationNotConfiguredException, RequestErrors, RequestException } from '@/common/exceptions';
import { TimeService } from '@/common/time/time.service';
import { stripeConfig } from '@/config/configuration';

/** Seconds a signed webhook stays acceptable (replay window); Stripe's default. */
const TOLERANCE_SECONDS = 300;

/**
 * Checks the `Stripe-Signature` header against the exact raw request bytes (`http-app.ts` keeps
 * them for the webhook path) with STRIPE_WEBHOOK_SECRET. Local computation, no network. The replay
 * window is measured on the injected clock, like every other time check.
 */
@Injectable()
export class StripeWebhookVerifier {
  constructor(
    @Inject(stripeConfig.KEY) private readonly config: ConfigType<typeof stripeConfig>,
    private readonly time: TimeService,
  ) {}

  verify(rawBody: unknown, signature: string | undefined): Stripe.Event {
    if (!this.config.webhookSecret) throw new IntegrationNotConfiguredException('Stripe');
    if (!Buffer.isBuffer(rawBody) || !signature) throw new RequestException(RequestErrors.INVALID_SIGNATURE);
    try {
      return Stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.config.webhookSecret,
        TOLERANCE_SECONDS,
        undefined,
        this.time.epochSeconds(),
      );
    } catch (error) {
      throw new RequestException(RequestErrors.INVALID_SIGNATURE, { cause: error });
    }
  }
}
