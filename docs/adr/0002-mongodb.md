# 0002. MongoDB with Mongoose, as a replica set everywhere

Status: accepted · Date: 2026-10-26

## Context

The prompt asks for MongoDB with Mongoose and pagination plugins. Transactions (and so the outbox) need a replica set.

## Decision

MongoDB 8 through Mongoose 9, `mongoose-paginate-v2` and `mongoose-aggregate-paginate-v2` behind `BaseRepository`. Local compose runs a single-node replica set (port 27047 to avoid clashing with a local MongoDB). Production runs with `autoIndex` off and applies indexes with `pnpm db:sync-indexes --apply`. Every wait (server selection, pool, transaction retries) is bounded.

## Consequences

- Good: Transactions and change-safe outbox writes are available in every environment, including tests.
- Cost: Developers cannot point the app at a standalone `mongod`; the compose service does it for them.
