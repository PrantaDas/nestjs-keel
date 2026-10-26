import Stripe from 'stripe';

/** The Stripe SDK client, one per process, created on first use (null without a secret key). */
let client: Stripe | undefined;

export function stripeClient(secretKey: string, timeoutMs: number): Stripe | undefined {
  if (!secretKey) return undefined;
  // SDK-level retries off: reads opt in per call; creates are never retried here (idempotency keys
  // still make a client retry safe on Stripe's side).
  client ??= new Stripe(secretKey, { timeout: timeoutMs, maxNetworkRetries: 0, appInfo: { name: 'nest-boilerplate' } });
  return client;
}
