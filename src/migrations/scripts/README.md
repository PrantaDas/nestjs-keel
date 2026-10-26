# Migrations

Create one with `pnpm migrate create <name>`: it writes `YYYYMMDDHHmmss-<name>.ts` here. Run with
`pnpm migrate status | up [--dry-run] | down [--steps n] | unlock`. The example to copy is
`20261026000000-notes-backfill-created-day.ts`.

Rules (a bad migration loses real data):

1. **Idempotent.** Running `up` twice must be safe: filter on "not yet migrated".
2. **Honour `dryRun`.** Count and log what would change; write nothing.
3. **Batch.** `forEachBatch` + `bulkWrite`. Never load a whole collection.
4. **Raw collections only** (`db.collection(...)`), never app models: models change, migrations must not.
5. **Real `down`.** Undo exactly what `up` did (mark the documents you touched when the change is not
   otherwise visible). If a change truly cannot be reversed, say so in `description` and back up first.
6. **Rehearse** on a copy of production data before running it in production.
7. **One runner at a time.** The runner takes a lock in `_migrations_lock`; a crashed run is released
   with `pnpm migrate unlock` after checking nothing is still running.
