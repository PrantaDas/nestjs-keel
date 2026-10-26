# 0007. Sessions in Redis with refresh-token rotation and reuse detection

Status: accepted · Date: 2026-10-26

## Context

Stateless JWTs cannot be revoked; a stolen refresh token is valid for weeks.

## Decision

Short access tokens (15 min) carry the session id; every request checks the session is live in the core Redis. Refresh tokens are single use: each refresh rotates the token id atomically (Lua). Presenting an already-used refresh token revokes the whole session. Sessions per user are capped; sign-out, password changes and staff actions revoke sessions and disconnect their sockets.

## Consequences

- Good: Revocation is immediate; theft of a refresh token is detected on its first reuse.
- Cost: Every authenticated request costs one Redis round trip; a core Redis outage makes authenticated routes answer 503 (fail closed).
