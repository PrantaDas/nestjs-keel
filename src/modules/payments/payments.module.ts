import { BullModule } from '@nestjs/bullmq';
import { DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { features } from '@/config/configuration';
import { QueueName } from '@/infra/queue/queue.constants';
import { PaymentGateway } from '@/integrations/stripe/payment-gateway.port';
import { StripePaymentGateway, UnconfiguredPaymentGateway } from '@/integrations/stripe/stripe-payment.gateway';
import { StripeWebhookVerifier } from '@/integrations/stripe/stripe-webhook.verifier';
import { AdminPaymentsController, PaymentsController, StripeWebhookController } from './payments.controller';
import { PaymentsService } from './payments.service';
import {
  BillingCustomer,
  BillingCustomerSchema,
  Payment,
  PaymentEvent,
  PaymentEventSchema,
  PaymentSchema,
  Subscription,
  SubscriptionSchema,
} from './schemas/billing.schemas';
import { StripeEventsProcessor } from './stripe-events.processor';
import { StripeEventsService } from './stripe-events.service';

const models = MongooseModule.forFeature([
  { name: BillingCustomer.name, schema: BillingCustomerSchema },
  { name: Payment.name, schema: PaymentSchema },
  { name: Subscription.name, schema: SubscriptionSchema },
  { name: PaymentEvent.name, schema: PaymentEventSchema },
]);
const queue = BullModule.registerQueue({ name: QueueName.STRIPE_EVENTS });

/**
 * Payments behind a feature switch (ADR 0008): without STRIPE_SECRET_KEY the Stripe SDK is never
 * created and the worker does not load the event processor; the routes stay, and every call answers
 * 503 INTEGRATION_NOT_CONFIGURED ("The payment service isn't set up yet…") instead of the app
 * failing at boot or answering 404.
 */
@Module({
  imports: [models, queue],
  providers: [
    PaymentsService,
    StripeEventsService,
    StripeWebhookVerifier,
    { provide: PaymentGateway, useClass: features.stripe() ? StripePaymentGateway : UnconfiguredPaymentGateway },
  ],
  exports: [PaymentsService, StripeEventsService, StripeWebhookVerifier, models, queue],
})
export class PaymentsCoreModule {}

@Module({
  imports: [PaymentsCoreModule],
  controllers: [PaymentsController, AdminPaymentsController, StripeWebhookController],
})
export class PaymentsApiModule {}

/** Worker side; empty without Stripe (nothing to process). */
@Module({})
export class PaymentsJobsModule {
  static forRoot(): DynamicModule {
    return features.stripe()
      ? { module: PaymentsJobsModule, imports: [PaymentsCoreModule], providers: [StripeEventsProcessor] }
      : { module: PaymentsJobsModule };
  }
}
