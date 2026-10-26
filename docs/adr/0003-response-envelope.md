# 0003. One envelope for every answer

Status: accepted · Date: 2026-10-26

## Context

Mobile and web clients need one parser and stable error identifiers; support needs a request id in every error.

## Decision

Success: `{ success: true, message, data, meta? }`. Error: `{ success: false, errorCode, error, errorMessage, details?, requestId }`. Controllers return plain data; a global interceptor and filter build the envelopes. Codes come from a central registry with a range per module (errors.md). Messages are written for people and guarded by a test. GraphQL carries the same fields in `extensions`; sockets in acks.

## Consequences

- Good: Clients branch on `error` / `errorCode`, show `errorMessage` as is.
- Cost: Raw answers (files, provider webhooks) must opt out with `@SkipEnvelope()`.
