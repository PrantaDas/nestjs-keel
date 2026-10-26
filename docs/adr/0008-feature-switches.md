# 0008. Optional integrations are switched by configuration

Status: accepted · Date: 2026-10-26

## Context

A fresh clone must boot with no third-party accounts, and a production deployment without (say) Stripe must not load its webhook worker.

## Decision

Every provider is optional: empty credentials mean "not set up" (503 `INTEGRATION_NOT_CONFIGURED` for that feature only). Where a whole module depends on one (payments), `features.*()` reads the environment when modules are declared, so the module, its webhook route and its queue worker are not even registered. `.env` is loaded before any module file is imported (`load-env.ts`).

## Consequences

- Good: Boot never fails for a missing provider; the app runs locally with only docker compose.
- Cost: Feature switches are read at import time: changing them needs a restart (as any env change).
