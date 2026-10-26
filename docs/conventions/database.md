# Database (MongoDB + Mongoose)

MongoDB runs as a **replica set** everywhere (local compose too): transactions and the outbox need
it. ADR: [0002](../adr/0002-mongodb.md).

## Schemas

- Start from `baseSchemaOptions` (`infra/database/base.schema.ts`): timestamps from the injected
  clock, no `__v`, `_id` kept.
- Enum and union props declare `type: String` explicitly (Mongoose cannot infer them from TS).
- **Every query has an index.** Declare indexes on the schema next to the fields; name compound
  ones after their query. Unique indexes that a race can hit get a human message with
  `defineDuplicateKeys` ([errors.md](errors.md)).
- Store the business day next to instants (`createdDay`), never recompute ([time.md](time.md)).
- Counters, versions and state changes use atomic updates (`$inc`, conditional filters), never
  read-modify-write.

## Repositories

Data access lives in a repository per collection extending `BaseRepository` (lean reads by default,
`paginate`, `aggregatePaginate`, session-aware writes). Services never import a Mongoose model of
another module: they go through a port ([microservices.md](../architecture/microservices.md)).

**Optimistic concurrency** for user edits: a `version` field, updates filter on
`{ _id, version: expectedVersion }` and `$inc` it; zero matches → `409` with the latest version in
`details` (`NOTE_EDITED_ELSEWHERE`).

## Transactions

`TransactionService.run(async (session) => …)` wraps a MongoDB transaction with bounded, jittered
retries (`MONGO_TRANSACTION_MAX_ATTEMPTS`, within `MONGO_TRANSACTION_RETRY_WINDOW_MS`). Pass the
session to every write, and write outbox events in the same transaction. Keep side effects (HTTP,
queues, sockets) **after** the commit: the callback may run more than once.

## Soft delete and audit (opt-in)

ADR: [0004](../adr/0004-soft-delete-and-audit-opt-in.md).

- **Soft delete:** `schema.plugin(softDeletePlugin)` adds `deletedAt` and hides deleted documents
  from find / count / update / aggregate unless `{ withDeleted: true }` is passed; the repository
  extends `SoftDeleteRepository` (`softDeleteById`, `restoreById`, `findByIdWithDeleted`, `purgeDeletedBefore`). Purge with a cron.
  Unique indexes that must allow re-creating a deleted value use
  `partialFilterExpression: { deletedAt: { $type: 'null' } }`.
- **Audit trail:** every staff write is recorded automatically (actor, action, target, request id,
  IP); `@Audit('notes.export')` names an action or audits a staff read; inside a service,
  `RequestContext.recordAudit({ resourceId, before, after })` stores the change itself (sanitised: no secrets).
  End-user requests are not audited. Entries expire after `AUDIT_RETENTION_DAYS`.

## Indexes in production

`MONGO_AUTO_INDEX=false` in production. Indexes are applied as a deploy step:

```bash
pnpm db:sync-indexes            # report missing / extra indexes
pnpm db:sync-indexes --apply    # create missing ones (never drops)
pnpm db:sync-indexes --drop     # also drop undeclared ones: careful
```

## Migrations

Data changes run through `pnpm migrate` (`status | up [--dry-run] | down [--steps n] | create <name>
| unlock`). Rules in [src/migrations/scripts/README.md](../../src/migrations/scripts/README.md):
idempotent, honour dry-run, batch, raw collections only, a real `down`, rehearse on a copy, one
runner at a time (lock). In the image: `node dist/cli/migrate.js up` (`pnpm migrate:dist up`).

## Local-only guard

The e2e suite and `pnpm seed` refuse a `MONGO_URI` that does not point at this machine
(`common/safety/local-only.ts`), so a stray `.env` cannot wipe a real cluster.
