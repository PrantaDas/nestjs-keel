# 0015. CI uses docker compose instead of service containers

Status: accepted · Date: 2026-10-26

## Context

GitHub Actions service containers cannot run MongoDB as a replica set without extra steps, and duplicating the infrastructure definition invites drift.

## Decision

The e2e CI job starts the same `docker compose` services developers use (`pnpm infra:up`), then runs the e2e suite in two server zones. The checks job (format, lint, typecheck, proto lint, unit tests in four zones, build) needs no services.

## Consequences

- Good: One definition of the infrastructure; CI fails the same way a laptop does.
- Cost: Slightly slower job start (image pulls), mitigated by the layer cache.
