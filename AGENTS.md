# Instructions for coding agents

NestJS 12 modular monolith, TypeScript strict, pnpm, Node 24. Read [README.md](README.md) first,
then the convention for whatever you touch (`docs/conventions/*.md`).

## Commands

```bash
pnpm lint && pnpm typecheck && pnpm test          # always, before saying something works
pnpm infra:up && pnpm test:e2e                     # when data, queues, HTTP or sockets change
E2E_ID=<name> pnpm test:e2e                        # isolated run (parallel checkouts)
pnpm messages:export && pnpm graphql:schema        # after changing messages, errors, routes or GraphQL types
```

Jest needs `--experimental-vm-modules` (NestJS 12 is ESM): use the pnpm scripts, not `npx jest`.

## Rules that the build enforces

- No `new Date()` / `Date.now()` outside `src/common/time`: inject `TimeService` or `Clock`.
- No `process.env` outside `src/config` and `src/cli`: add the variable to `env.validation.ts`,
  `configuration.ts` and `.env.example`.
- `src/modules/a` never imports `src/modules/b`: use a port in `src/common/contracts` or an event.
- `common` never imports `infra`/`integrations`/`modules`; `infra` and `integrations` never import `modules`.
- Every message shown to people is a sentence with no internals (`test/unit/api-messages.spec.ts`).
- Every route is documented (`test/unit/openapi-contract.spec.ts`); generated files are current.
- No `any`; no `@ts-ignore`; explicit return types where the type is not obvious.

## Rules that the build cannot enforce

- Throw registry exceptions (`throw new NotesException(NotesErrors.NOTE_NOT_FOUND)`), never `Error`.
- Controllers return plain data; never build envelopes.
- Ownership in the query filter; 404 for other people's records.
- Jobs and event handlers are idempotent; side effects after the transaction commits.
- Provider calls go through a port + `guardedCall`; non-idempotent sends through `SendOnceGuard`.
- Comment intent (why), not mechanics. Match the surrounding style.
- Copy patterns from `src/modules/examples`; `pnpm g:module <plural>` for a new module.

## Do not

- Edit generated files by hand (`schema.gql`, `docs/api/messages.md`, `src/infra/transport/grpc/generated`).
- Commit `.env` or any credential; read secrets only from config.
- Run the seed or e2e against a non-local database (both refuse; do not add `--force` to get past it).
- Push, or add AI attribution trailers to commits.
