# Migrations

Create one with `pnpm migrate create <name>`. It generates `YYYYMMDDHHmmss-<name>.ts` here.

Rules (production has 50K+ daily users; a bad migration loses data):

1. **Idempotent.** Running `up` twice must be safe (filter on "not yet migrated").
2. **Honour `ctx.dryRun`.** In a dry run, count and log what would change; write nothing.
3. **Batch.** Use `forEachBatch` + `bulkWrite`. Never load a whole collection.
4. **Raw collections only** (`ctx.db.collection(...)`), never app models: models change, migrations must not.
5. **Real `down`.** Test it. If a change truly can't be reversed, say so in `description` and back up first.
6. **Rehearse** against the restored production dump before running in production.
