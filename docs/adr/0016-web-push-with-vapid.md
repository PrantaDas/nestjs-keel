# 0016. Browser push with Web Push and VAPID

Status: accepted · Date: 2026-10-26

## Context

App devices receive push through FCM. Browsers can too (the FCM JS SDK), but that ties every web
client to Firebase, needs a Firebase config in the page, and does not reach Safari without extra
work. Every current browser implements the standard instead: the Push API on the page, RFC 8030
delivery, VAPID (RFC 8292) to identify the sender and aes128gcm (RFC 8291) to encrypt the payload.

## Decision

- Browsers subscribe with the standard Push API against our own VAPID key pair; the API stores the
  subscription (`web_push_subscriptions`) and the worker delivers with the `web-push` library behind
  the `WebPushSender` port (`VapidWebPushSender`).
- `web-push` only encrypts and signs. The request goes out through `fetch` in the adapter, so it gets
  the `webpush` circuit breaker, `WEB_PUSH_TIMEOUT_MS` and the shared error classification.
- The `push` channel of `Notifier` reaches app devices and browsers alike: feature modules do not
  choose.
- The server POSTs to a URL the browser chose, so subscriptions are accepted only on an allowlist of
  push service hosts (`WEB_PUSH_ALLOWED_HOSTS`, checked at registration and again at send), over
  https on port 443, without redirects.
- Only 404 and 410 delete a subscription. 403 is a VAPID problem on our side (wrong key, clock) and
  would otherwise wipe every browser at once.

## Consequences

- Good: no vendor SDK in the page; Chrome, Firefox, Edge and Safari (16.4+, installed web app on iOS)
  with one code path; the private key never leaves the server.
- Cost: no topics: a broadcast to every browser is a `Notifier` send to the accounts. Rotating the
  VAPID keys invalidates every subscription (browsers must subscribe again).
- Cost: one breaker for every push service: an outage at one vendor can pause deliveries to the
  others for `INTEGRATION_BREAKER_OPEN_SECONDS`.
