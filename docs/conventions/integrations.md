# Outside services

Every provider sits behind a **port** (an abstract class in `src/integrations/<kind>/<kind>.port.ts`)
with one adapter. Feature code injects the port, never an SDK; tests bind a fake.

| Port             | Adapter                                      | Config (empty = off)     | Breaker key |
| ---------------- | -------------------------------------------- | ------------------------ | ----------- |
| `FileStorage`    | `S3FileStorage` (AWS SDK v3, presigned URLs) | `S3_BUCKET`              | `s3`        |
| `MailSender`     | `SmtpMailSender` (Nodemailer)                | `SMTP_HOST`              | `smtp`      |
| `SmsSender`      | `TwilioSmsSender`                            | `TWILIO_ACCOUNT_SID`     | `twilio`    |
| `PushSender`     | `FcmPushSender` (firebase-admin)             | `FIREBASE_CREDENTIALS_*` | `fcm`       |
| `WebPushSender`  | `VapidWebPushSender` (web-push + `fetch`)    | `WEB_PUSH_VAPID_*`       | `webpush`   |
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

The `push` channel reaches both kinds of device: app installations (FCM device tokens, registered at
sign-in or `PUT /users/me/device`) and browsers (Web Push subscriptions, below). `pushSent` /
`pushFailed` on a delivery count both.

## Browser push (Web Push)

Standard Web Push with VAPID ([ADR 0016](../adr/0016-web-push-with-vapid.md)): no Firebase in the
page, works in Chrome, Firefox, Edge and Safari.

1. `pnpm webpush:keys` prints a key pair → `WEB_PUSH_VAPID_PUBLIC_KEY` / `WEB_PUSH_VAPID_PRIVATE_KEY`.
   Set `WEB_PUSH_SUBJECT` to a real `mailto:` or `https:` contact. Keep the pair: new keys
   invalidate every subscription.
2. The page asks for permission, subscribes and sends the subscription to the API:

| Route                                                     | Auth   | Does                                              |
| --------------------------------------------------------- | ------ | ------------------------------------------------- |
| `GET /api/v1/notifications/web-push/public-key`           | public | `{ publicKey }` for `applicationServerKey`        |
| `PUT /api/v1/notifications/web-push/subscriptions`        | bearer | Register or refresh this browser (upsert)         |
| `GET /api/v1/notifications/web-push/subscriptions`        | bearer | My browsers (label, push service host, last seen) |
| `DELETE /api/v1/notifications/web-push/subscriptions/:id` | bearer | Remove one of my browsers                         |
| `POST /api/v1/notifications/web-push/unsubscribe`         | bearer | `{ endpoint }`: this browser unsubscribed itself  |
| `POST /api/v1/notifications/web-push/test`                | bearer | A test push to my browsers and devices            |

```js
// page
const { data } = await (await fetch('/api/v1/notifications/web-push/public-key')).json();
const registration = await navigator.serviceWorker.register('/sw.js');
if ((await Notification.requestPermission()) !== 'granted') return;
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: data.publicKey, // base64url string, accepted by every current browser
});
await fetch('/api/v1/notifications/web-push/subscriptions', {
  method: 'PUT',
  headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ ...subscription.toJSON(), label: 'Firefox on Linux' }),
});

// sw.js: the payload is { title, body?, image?, url?, data? }
self.addEventListener('push', (event) => {
  const { title, body, image, url, data } = event.data.json();
  event.waitUntil(self.registration.showNotification(title, { body, image, data: { url, ...data } }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url ?? '/'));
});
```

Rules the module keeps:

- **Allowlisted push services only.** The server POSTs to the subscription URL, so it must be https
  on port 443 at a host in `WEB_PUSH_ALLOWED_HOSTS` (default: Chrome/FCM, Mozilla, Apple, Windows),
  checked at registration (400, code 4002) and again before every send; redirects are refused.
- **The URL is a secret.** Anyone holding it (plus the keys) can push to that browser: responses
  only show the push service host.
- **Same lifecycle as device tokens.** Signing the session out, deactivation and deletion remove the
  subscriptions; 404 / 410 from the push service delete them; an account keeps its 20 most recently
  seen browsers.
- **Per-browser failures are outcomes, not job failures.** Deliveries are claimed like every other
  push, so a failed browser is counted in `pushFailed` and never re-sent. The payload is capped at
  3800 bytes (`data.url` becomes the click target).
