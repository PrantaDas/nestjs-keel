import { IntegrationNotConfiguredException } from '@/common/exceptions';
import { UnconfiguredPaymentGateway } from '@/integrations/stripe/stripe-payment.gateway';
import { PaymentsJobsModule } from './payments.module';

describe('payments feature switch', () => {
  const previous = process.env.STRIPE_SECRET_KEY;
  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = previous;
  });

  it('loads no event processor without a Stripe key, and the processor with one', () => {
    process.env.STRIPE_SECRET_KEY = '';
    expect(PaymentsJobsModule.forRoot().providers).toBeUndefined();
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
    expect(PaymentsJobsModule.forRoot().providers).toHaveLength(1);
  });

  it('answers every call with a clear "not set up" error instead of failing at boot', async () => {
    const gateway = new UnconfiguredPaymentGateway();
    await expect(gateway.listPrices()).rejects.toBeInstanceOf(IntegrationNotConfiguredException);
    await expect(gateway.createPortalSession()).rejects.toMatchObject({
      message: "The payment service isn't set up yet, so this can't be done right now. Please contact support.",
    });
  });
});
