# Outside services

Every provider sits behind a **port** (an abstract class in `src/integrations/<kind>/<kind>.port.ts`)
with one adapter. Feature code injects the port, never an SDK; tests bind a fake.

| Port             | Adapter                                      | Config (empty = off)     | Breaker key |
| ---------------- | -------------------------------------------- | ------------------------ | ----------- |
| `FileStorage`    | `S3FileStorage` (AWS SDK v3, presigned URLs) | `S3_BUCKET`              | `s3`        |
| `MailSender`     | `SmtpMailSender` (Nodemailer)                | `SMTP_HOST`              | `smtp`      |
| `SmsSender`      | `TwilioSmsSender`                            | `TWILIO_ACCOUNT_SID`     | `twilio`    |
| `PushSender`     | `FcmPushSender` (firebase-admin)             | `FIREBASE_CREDENTIALS_*` | `fcm`       |
| `PaymentGateway` | `StripePaymentGateway`                       | `STRIPE_SECRET_KEY`      | `stripe`    |

## Rules for an adapter

1. **Lazy client, never a boot failure.** Build the SDK client on first use; a missing credential
   throws `IntegrationNotConfiguredException` (503 "not set up yet"), which jobs treat as final.
2. **Explicit timeout** from `resilienceConfig` (`*_TIMEOUT_MS`), SDK auto-retry **off**: retries
   are the queue's job, with backoff and visibility.
3. **Every call through `guardedCall(INTEGRATION, fn)`**: the integration's circuit breaker (opens
   after `INTEGRATION_BREAKER_FAILURE_THRESHOLD` transient failures, fails fast for
   `INTEGRATION_BREAKER_OPEN_SECONDS`, then lets one probe through; per-integration overrides in
   `INTEGRATION_BREAKER_OVERRIDES`) and errors classified as `IntegrationCallException`:
   `transient` (worth a retry), `retryable`, and `ambiguous` (the provider may have acted).
4. **Non-idempotent sends** (SMS, e-mail, push) go through `SendOnceGuard.run(integration, onceKey, fn)`:
   a Redis claim before the call, so a retried job cannot send twice; an ambiguous failure is
   recorded as `unknown` and never repeated automatically.
5. **Provider words stay inside the adapter.** Errors reaching people say "the text message
   service", never "Twilio" (the message guard test enforces it).
6. Add the display name → breaker key to `INTEGRATION_KEYS` (`resilience/guarded-call.ts`) and the
   secrets to the redaction list if they have a new name.

```ts
async send(message: SmsMessage, options: { onceKey?: string } = {}) {
  const client = this.twilio();                       // lazy; throws INTEGRATION_NOT_CONFIGURED
  return this.once.run(INTEGRATION, options.onceKey, () =>
    guardedCall(INTEGRATION, () => client.messages.create({ to: message.to, body: message.body, from })),
  );
}
```

A provider without a usable SDK: call its REST API with `fetchJson(INTEGRATION, url, init)`
(`integrations/http.util.ts`): timeout, breaker, JSON parsing and classified errors in one call.

## Inbound: Stripe webhooks

`POST /api/webhooks/stripe` (no version prefix, public, excluded from Swagger) verifies the
`Stripe-Signature` header on the raw body with `STRIPE_WEBHOOK_SECRET` (tolerance 5 minutes, on the
injected clock), stores the event id (duplicates are acknowledged and ignored), enqueues it on
`stripe-events` and answers 200 at once. Handlers apply forward-only state changes, so replayed or
out-of-order events cannot move a subscription backwards.

Locally: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`, put the printed `whsec_…` in
`STRIPE_WEBHOOK_SECRET`, then `stripe trigger checkout.session.completed`. Without the Stripe CLI,
`test/e2e/payments.e2e-spec.ts` shows how to sign a payload with the secret
(`stripe.webhooks.generateTestHeaderString`).

## Notifications

Feature modules never call `PushSender` or `MailSender` directly to reach a user: they call the
`Notifier` port (`common/contracts/notifier.contract.ts`). The notifications module stores the inbox item,
queues the delivery, resolves device tokens, skips unreachable (deactivated, deleted) accounts at
enqueue **and** at send time, prunes tokens the provider reports dead, and dedupes per occurrence key.
