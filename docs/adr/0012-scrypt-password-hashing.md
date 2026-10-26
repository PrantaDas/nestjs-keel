# 0012. scrypt for passwords

Status: accepted · Date: 2026-10-26

## Context

The reference project used bcrypt. bcrypt truncates at 72 bytes and needs a native or slow JS build; Argon2 needs a native addon.

## Decision

Node's built-in `crypto.scrypt` with N=2^15, r=8, p=3 (OWASP's baseline), a 16-byte salt and the parameters encoded in the stored hash so they can be raised later (old hashes still verify). Unknown accounts verify against a decoy hash for equal timing.

## Consequences

- Good: No native dependency, no length truncation, tunable.
- Cost: About 100 ms of CPU per sign-in by design; sign-in is throttled.
