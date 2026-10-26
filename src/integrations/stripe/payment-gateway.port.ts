/** A price as the app shows it (Stripe's price + its product). Amounts in the currency's minor unit. */
export interface GatewayPrice {
  id: string;
  productId: string;
  productName: string;
  description: string | null;
  unitAmount: number;
  currency: string;
  recurring: { interval: 'day' | 'week' | 'month' | 'year'; intervalCount: number } | null;
}

export interface NewProduct {
  name: string;
  description?: string;
  unitAmount: number;
  currency: string;
  interval?: 'day' | 'week' | 'month' | 'year';
}

export interface CheckoutInput {
  customerId: string;
  priceId: string;
  mode: 'payment' | 'subscription';
  quantity: number;
  /** Our user id, stored on the session so the webhook can attribute it. */
  userId: string;
  successUrl: string;
  cancelUrl: string;
}

/**
 * Payments. Only the payments module uses it; Stripe is bound when STRIPE_SECRET_KEY is set,
 * otherwise every call fails with INTEGRATION_NOT_CONFIGURED. Creates take an idempotency key:
 * the provider then ignores a repeat, so a retried request never charges or creates twice.
 */
export abstract class PaymentGateway {
  /** Active prices with their products (a read: retried on network errors). */
  abstract listPrices(): Promise<GatewayPrice[]>;
  abstract getPrice(priceId: string): Promise<GatewayPrice | null>;
  abstract createProductWithPrice(input: NewProduct, idempotencyKey: string): Promise<GatewayPrice>;
  abstract createCustomer(
    input: { userId: string; email: string | null; name: string },
    idempotencyKey: string,
  ): Promise<string>;
  abstract createCheckoutSession(input: CheckoutInput, idempotencyKey: string): Promise<{ id: string; url: string }>;
  abstract createPaymentIntent(
    input: { customerId: string; amount: number; currency: string; userId: string; priceId: string },
    idempotencyKey: string,
  ): Promise<{ id: string; clientSecret: string }>;
  abstract createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
}
