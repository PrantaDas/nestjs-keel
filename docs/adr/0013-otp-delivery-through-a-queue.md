# 0013. One-time codes are delivered through a queue

Status: accepted · Date: 2026-10-26

## Context

Sending an SMS inside the request makes sign-in latency and availability depend on the SMS provider, and a retried request can send twice.

## Decision

`OtpService` stores the code (as an HMAC) and enqueues delivery on `otp-delivery`; the worker sends with a send-once claim and a provider rate limit. Unknown recipients get the same answer and an undeliverable code. Locally `OTP_DEV_LOG=true` logs codes instead of sending them (refused in production).

## Consequences

- Good: Fast, provider-independent request; no double sends; codes are never stored in clear.
- Cost: A worker must run for codes to arrive (the smoke test checks every queue has one).
