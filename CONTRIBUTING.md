# Contributing

## Setup

Node 24, pnpm 11 (`corepack enable`), Docker. Then the [quick start](README.md#quick-start-about-5-minutes).
A dev container (`.devcontainer/`) gives the same toolchain with the services attached.

## Adding a feature module

```bash
pnpm g:module invoices            # plural, kebab case; --dry-run to preview
```

It copies `src/modules/examples` (the notes resource) into `src/modules/invoices` with renamed
classes, routes, events and queue, a free error-code block, a queue policy row, an e2e test, and
wires it into every process module and the CLI. Then:

1. Replace the example fields (title, body, tags, reminder) in `schemas/`, `dto/` and the views.
2. Delete what the module does not need (gateway, resolver, cron, processor) and its wiring lines.
3. Write the module's rules in its `README.md`.
4. If other modules need it, add a port in `src/common/contracts` (see the examples module's
   `// #region port` blocks and [microservices.md](docs/architecture/microservices.md)).
5. `pnpm messages:export && pnpm graphql:schema`, then the checks below.

Modules never import each other (lint fails); they use ports and domain events.

## Definition of done

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` green
- [ ] Tests for the behaviour (unit for pure logic, e2e for anything touching data, queues, HTTP)
- [ ] Every route: `@ApiOperation` with a unique `operationId`, an envelope decorator, its domain
      errors, `@ResponseMessage`; permissions for staff routes ([responses](docs/conventions/responses.md))
- [ ] Errors from the module's registry block with human messages ([errors](docs/conventions/errors.md),
      [messages](docs/conventions/messages.md))
- [ ] Time through `TimeService`; business day stored, never recomputed ([time](docs/conventions/time.md))
- [ ] Every query indexed; migrations for data changes, with a real `down` ([database](docs/conventions/database.md))
- [ ] Jobs idempotent, with a policy row ([queues](docs/conventions/queues.md))
- [ ] Provider calls through a port and `guardedCall` ([integrations](docs/conventions/integrations.md))
- [ ] Generated docs current (`messages:export`, `graphql:schema`), env vars in `.env.example` and the schema
- [ ] An ADR in `docs/adr/` for a decision that is hard to reverse or surprising

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), checked by commitlint on `commit-msg`:

```
feat(notes): add reminders in the note's own time zone
fix(identity): revoke the session when a used refresh token comes back
docs: explain the outbox relay
```

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`. Subject in lower
case, imperative, no period. Body says why. The pre-commit hook runs ESLint and Prettier on staged
files.

## Dependencies

Versions are pinned (no ranges) and Renovate proposes updates after a 14-day minimum release age.
Add a dependency only with a reason in the PR; prefer the platform (`node:crypto`, `fetch`).
