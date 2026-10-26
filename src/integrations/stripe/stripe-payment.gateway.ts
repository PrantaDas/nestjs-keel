import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type Stripe from 'stripe';
import { IntegrationNotConfiguredException } from '@/common/exceptions';
import { resilienceConfig, stripeConfig } from '@/config/configuration';
import { guardedCall } from '@/integrations/resilience/guarded-call';
import { timeoutsFrom } from '@/integrations/resilience/settings';
import { CheckoutInput, GatewayPrice, NewProduct, PaymentGateway } from './payment-gateway.port';
import { stripeClient } from './stripe.client';

const INTEGRATION = 'Stripe';
/** Reads only: a list or retrieve may be retried, a create never is. */
const READ = { maxNetworkRetries: 2 } as const;

function toPrice(price: Stripe.Price): GatewayPrice {
  const product = typeof price.product === 'object' ? (price.product as Stripe.Product) : undefined;
  return {
    id: price.id,
    productId: typeof price.product === 'string' ? price.product : (product?.id ?? ''),
    productName: product?.name ?? '',
    description: product?.description ?? null,
    unitAmount: price.unit_amount ?? 0,
    currency: price.currency,
    recurring: price.recurring
      ? {
          interval: price.recurring.interval as NonNullable<GatewayPrice['recurring']>['interval'],
          intervalCount: price.recurring.interval_count,
        }
      : null,
  };
}

/**
 * Stripe behind the `PaymentGateway` port: every call has STRIPE_TIMEOUT_MS, goes through the
 * `stripe` circuit breaker and becomes a classified integration error on failure (the message a
 * person sees names "the payment service", never Stripe).
 */
@Injectable()
export class StripePaymentGateway extends PaymentGateway {
  private readonly timeoutMs: number;

  constructor(
    @Inject(stripeConfig.KEY) private readonly config: ConfigType<typeof stripeConfig>,
    @Optional() @Inject(resilienceConfig.KEY) resilience?: ConfigType<typeof resilienceConfig>,
  ) {
    super();
    this.timeoutMs = timeoutsFrom(resilience).stripe;
  }

  async listPrices(): Promise<GatewayPrice[]> {
    const stripe = this.stripe();
    const prices = await this.call(() =>
      stripe.prices.list({ active: true, limit: 100, expand: ['data.product'] }, READ),
    );
    return prices.data
      .filter((price) => typeof price.product !== 'object' || (price.product as Stripe.Product).active)
      .map(toPrice);
  }

  async getPrice(priceId: string): Promise<GatewayPrice | null> {
    const stripe = this.stripe();
    try {
      const price = await this.call(() => stripe.prices.retrieve(priceId, { expand: ['product'] }, READ));
      return price.active ? toPrice(price) : null;
    } catch (error) {
      // An unknown price is an answer, not an outage.
      if ((error as { cause?: { statusCode?: number } }).cause?.statusCode === 404) return null;
      throw error;
    }
  }

  async createProductWithPrice(input: NewProduct, idempotencyKey: string): Promise<GatewayPrice> {
    const stripe = this.stripe();
    const product = await this.call(() =>
      stripe.products.create(
        { name: input.name, description: input.description },
        { idempotencyKey: `${idempotencyKey}-product` },
      ),
    );
    const price = await this.call(() =>
      stripe.prices.create(
        {
          product: product.id,
          unit_amount: input.unitAmount,
          currency: input.currency,
          recurring: input.interval ? { interval: input.interval } : undefined,
          expand: ['product'],
        },
        { idempotencyKey: `${idempotencyKey}-price` },
      ),
    );
    return toPrice(price);
  }

  async createCustomer(
    input: { userId: string; email: string | null; name: string },
    idempotencyKey: string,
  ): Promise<string> {
    const stripe = this.stripe();
    const customer = await this.call(() =>
      stripe.customers.create(
        { email: input.email ?? undefined, name: input.name, metadata: { userId: input.userId } },
        { idempotencyKey },
      ),
    );
    return customer.id;
  }

  async createCheckoutSession(input: CheckoutInput, idempotencyKey: string): Promise<{ id: string; url: string }> {
    const stripe = this.stripe();
    const session = await this.call(() =>
      stripe.checkout.sessions.create(
        {
          mode: input.mode,
          customer: input.customerId,
          line_items: [{ price: input.priceId, quantity: input.quantity }],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.userId,
          metadata: { userId: input.userId, priceId: input.priceId },
        },
        { idempotencyKey },
      ),
    );
    return { id: session.id, url: session.url ?? '' };
  }

  async createPaymentIntent(
    input: { customerId: string; amount: number; currency: string; userId: string; priceId: string },
    idempotencyKey: string,
  ): Promise<{ id: string; clientSecret: string }> {
    const stripe = this.stripe();
    const intent = await this.call(() =>
      stripe.paymentIntents.create(
        {
          amount: input.amount,
          currency: input.currency,
          customer: input.customerId,
          automatic_payment_methods: { enabled: true },
          metadata: { userId: input.userId, priceId: input.priceId },
        },
        { idempotencyKey },
      ),
    );
    return { id: intent.id, clientSecret: intent.client_secret ?? '' };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    const stripe = this.stripe();
    const session = await this.call(() =>
      stripe.billingPortal.sessions.create({ customer: input.customerId, return_url: input.returnUrl }),
    );
    return { url: session.url };
  }

  private call<T>(request: () => Promise<T>): Promise<T> {
    return guardedCall(INTEGRATION, request, { deadlineMs: this.timeoutMs + 1000 });
  }

  private stripe(): Stripe {
    const client = stripeClient(this.config.secretKey, this.timeoutMs);
    if (!client) throw new IntegrationNotConfiguredException(INTEGRATION);
    return client;
  }
}

/** Bound instead of Stripe when STRIPE_SECRET_KEY is empty: every call says so, clearly. */
@Injectable()
export class UnconfiguredPaymentGateway extends PaymentGateway {
  private fail(): never {
    throw new IntegrationNotConfiguredException(INTEGRATION);
  }

  listPrices = async (): Promise<GatewayPrice[]> => this.fail();
  getPrice = async (): Promise<GatewayPrice | null> => this.fail();
  createProductWithPrice = async (): Promise<GatewayPrice> => this.fail();
  createCustomer = async (): Promise<string> => this.fail();
  createCheckoutSession = async (): Promise<{ id: string; url: string }> => this.fail();
  createPaymentIntent = async (): Promise<{ id: string; clientSecret: string }> => this.fail();
  createPortalSession = async (): Promise<{ url: string }> => this.fail();
}
