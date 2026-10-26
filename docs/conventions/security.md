# Security rules for code

What a change must do to stay safe. The threat model and the reasoning are in
[architecture/security.md](../architecture/security.md).

## Every route

- **Authenticated by default.** `JwtAuthGuard` is global; `@Public()` opts out (sign-in, health,
  webhooks) and needs a reason in review. Machine clients use `@ApiKeyAuth()` (keys stored as
  SHA-256 digests in `API_KEYS`, compared in constant time).
- **Authorise by permission, not role**: `@RequirePermissions(Permission.USERS_WRITE)`. Roles map to
  permissions in one table (`common/auth/permissions.ts`); add a permission there, never an
  `if (role === …)` in a service. `@Roles()` exists for the rare route that truly is about the role.
- **Ownership in the query.** Load user data with the owner in the filter
  (`{ _id, ownerId: user.id }`) so another account's id reads as "not found" (404, not 403: no
  existence leak).
- **Validate everything** with a DTO: whitelist on, unknown fields rejected, `@MaxLength` on every
  string, `@ArrayMaxSize` on every array, `@Max` on page sizes. Operator-like keys (`$where`,
  `a.b`) are stripped from all input by `sanitizeInputMiddleware`; never pass a request object
  into a Mongo filter as is.
- **Rate limits**: global per user (or IP), `@AuthThrottle()` on sign-in/sign-up, `@OtpThrottle()`
  on routes that send a code. Expensive routes get their own `@Throttle`.
- **Idempotency-Key** is honoured on unsafe methods when the client sends one; payment-like actions
  should require it.

## Secrets and personal data

- Secrets only come from the environment (validated in `config/env.validation.ts`); production
  refuses the local placeholder secrets and `OTP_DEV_LOG`. Never log them: the logger and Sentry
  redact `password`, `token`, `secret`, `authorization`, `apiKey`, `otp`, … at any depth
  (`common/utils/sanitize.ts`); add a key there when you add a new kind of secret.
- Responses go through views: no password hashes, token ids, storage keys, provider ids.
- Job payloads and outbox events carry ids, not documents.

## Accounts

- Passwords: scrypt (N = 2^15, r = 8, p = 3) with per-hash salt; sign-in against an unknown account
  still verifies a decoy hash (same timing). Lockout after `AUTH_MAX_FAILED_LOGINS`.
- Sessions live in Redis; access tokens are short-lived and checked against the live session on
  every request and socket handshake. Refresh tokens rotate on use; **reusing an old refresh token
  revokes the whole session** (theft detection). ADR: [0007](../adr/0007-redis-sessions.md).
- OTP codes are stored as HMACs, single use, with send/verify limits; unknown recipients get the
  same answer as known ones. ADR: [0013](../adr/0013-otp-delivery-through-a-queue.md).
- Deactivated or deleted accounts cannot sign in, keep no live session, and receive no
  notifications (`isReachable` in the identity module).

## Inbound webhooks

Verify the provider signature on the **raw body** before parsing (`RAW_BODY_ROUTES` in
`bootstrap/http-app.ts`), reject old timestamps (replay), dedupe by event id, enqueue and answer
fast. See the Stripe webhook (`modules/payments`).

## Outbound calls

Every provider call goes through its port and `guardedCall` (timeout, circuit breaker, classified
errors) — [integrations.md](integrations.md). Uploads go straight to S3 through presigned URLs that sign the content type and size, under a
key scoped to the user; the object is checked (`headObject`: size, type, prefix) before it is
attached. The API never streams user files (see the avatar routes in the identity module).
