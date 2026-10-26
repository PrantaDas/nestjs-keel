# Security: threat model

Rules for writing code are in [conventions/security.md](../conventions/security.md). This page lists
what we defend against, how, and what is left to the platform.

## Assets

Accounts and sessions; personal data (names, e-mail, phone, avatars, device tokens); user content;
payment state; staff capabilities (user management, ops, audit); provider credentials and secrets.

## Actors

Anonymous internet clients; signed-in users trying to reach others' data; staff with limited roles;
machine clients with API keys; providers calling webhooks; someone holding a stolen token, a leaked
`.env` or a database copy.

## Threats and controls

| Threat                                 | Control                                                                                                                                                                                                                               | Where                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Credential stuffing, password guessing | Per-route auth throttle; per-account failed-login lockout (`AUTH_MAX_FAILED_LOGINS`, `AUTH_LOCKOUT_SECONDS`) that fails closed; same answer and timing for unknown accounts (decoy scrypt hash)                                       | `identity/auth`, `users/password.ts`                                                |
| Weak or leaked password hashes         | scrypt N=2^15 r=8 p=3, per-hash salt, parameters encoded in the hash so they can be raised later                                                                                                                                      | ADR [0012](../adr/0012-scrypt-password-hashing.md)                                  |
| Stolen access token                    | 15-minute lifetime; every request and socket handshake also checks the live session in Redis, so sign-out, a password change or a staff revocation takes effect at once                                                               | `sessions/session.service.ts`, `jwt-auth.guard.ts`                                  |
| Stolen refresh token                   | Single use, rotated each refresh; **presenting an old one revokes the whole session** (both the thief and the user are signed out; the user signs in again)                                                                           | `sessions/session.store.ts` (atomic Lua), ADR [0007](../adr/0007-redis-sessions.md) |
| OTP brute force / SMS pumping          | 6 digits, 5 attempts, 5-minute TTL, resend cooldown, hourly send and verify caps per recipient (fail closed), per-IP throttle; stored as HMAC, compared in constant time, consumed atomically; unknown recipients get the same answer | `identity/otp`, ADR [0013](../adr/0013-otp-delivery-through-a-queue.md)             |
| Account enumeration                    | Sign-in, OTP request and forgot-password answer the same for known and unknown accounts; sign-up does say an e-mail is taken (a product trade-off: the throttle limits probing)                                                       | `identity/auth`                                                                     |
| Reading someone else's data (IDOR)     | Owner in every query filter; not-found rather than forbidden                                                                                                                                                                          | services, e2e tests                                                                 |
| Privilege escalation                   | Permissions table per role; staff routes need permissions; role changes and staff writes audited; only a super admin creates super admins (CLI)                                                                                       | `common/auth/permissions.ts`, `modules/audit`                                       |
| NoSQL injection, mass assignment       | DTO whitelist (unknown fields rejected), operator keys stripped from all input, typed filters                                                                                                                                         | `common/pipes`, `sanitize-input.middleware.ts`                                      |
| Forged webhooks, replays               | Signature over the raw body, 5-minute timestamp tolerance, event id dedupe                                                                                                                                                            | `payments`, `integrations/stripe`                                                   |
| Abuse / resource exhaustion            | Global and per-route rate limits, body size limit, request timeouts, page size cap, GraphQL depth/complexity limits, socket event limits and max message size                                                                         | `infra/security`, `infra/graphql`, `infra/realtime`                                 |
| Browser attacks                        | Helmet headers, CORS allow-list (`CORS_ORIGINS`, none by default), bearer tokens (no cookies → no CSRF)                                                                                                                               | `bootstrap/http-app.ts`                                                             |
| Secrets in logs, errors, Sentry        | Recursive redaction by key name; errors to clients never include internals (guard test)                                                                                                                                               | `common/utils/sanitize.ts`, `api-messages.spec.ts`                                  |
| Placeholder secrets in production      | Env schema refuses `change-me` secrets, equal access/refresh secrets, `OTP_DEV_LOG=true` in production                                                                                                                                | `config/env.validation.ts`                                                          |
| Tests or seed wiping real data         | Local-only guard on `MONGO_URI` for e2e and seed                                                                                                                                                                                      | `common/safety/local-only.ts`                                                       |
| Malicious uploads                      | Presigned uploads with signed type and size, user-scoped keys, checked before use; files never pass through the API                                                                                                                   | `identity/users`, `integrations/storage`                                            |
| Deleted users still contacted          | Reachability checked at enqueue and at send; deletion revokes sessions and removes device tokens                                                                                                                                      | `notifications`, `identity`                                                         |
| Dependency vulnerabilities             | Pinned versions, lockfile, Renovate with a 14-day minimum release age, `pnpm audit` in CI recommended                                                                                                                                 | `renovate.json`                                                                     |
| Container escape impact                | Non-root user, tini, no build tools in the runtime image                                                                                                                                                                              | `Dockerfile`                                                                        |

## Left to the platform

TLS termination and HSTS at the load balancer; WAF and DDoS protection; network isolation of
MongoDB, Redis and RabbitMQ (no public access, TLS + auth in production URIs); secret storage and
rotation (inject env from a secret manager); backups and encryption at rest; mTLS between services
once a module is extracted.

## Rotating secrets

- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`: changing one signs everybody out (all tokens invalid).
  Do it on a leak; otherwise rarely. OTP HMAC keys derive from the access secret, so pending codes
  also become invalid.
- `API_KEYS`: add the new digest next to the old one, move clients, remove the old one.
- `STRIPE_WEBHOOK_SECRET`: Stripe allows two secrets during a roll; deploy the new one when Stripe
  starts signing with it.
