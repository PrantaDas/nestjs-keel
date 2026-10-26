# nestjs-keel

[![CI](https://github.com/PrantaDas/nestjs-keel/actions/workflows/ci.yml/badge.svg)](https://github.com/PrantaDas/nestjs-keel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 24](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![NestJS 12](https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&logoColor=white)
![TypeScript 6](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)

**The keel your NestJS backend is built on.** A production-ready NestJS 12 template: REST,
GraphQL, Socket.IO, background jobs and schedules as separate processes from one codebase and one
image, with MongoDB, Redis, BullMQ, S3, e-mail, SMS, push, Stripe, gRPC and RabbitMQ wired in,
tested and documented. Deploys to Render, a VPS with PM2 + nginx, or any container platform.

- **Node 24**, **pnpm 11**, TypeScript 6 (strict, no `any`), NestJS 12 on Express 5
- MongoDB 8 (replica set) with Mongoose 9, Redis 7 (core + optional cache), BullMQ 6
- Envelopes, a central error registry and human messages enforced by tests
- Time-zone-safe by construction (clock injection, business day, lint rules, multi-zone tests)
- Sessions with refresh rotation and reuse detection, OTP, roles and permissions, audit trail
- Ready to split into services: ports between modules, outbox, one transport for gRPC and RabbitMQ

## What's inside

| Area                                    | You get                                                                                                                                                                                                                                                               | Reference                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Accounts** (`modules/identity`)       | Register, password and one-time-code sign-in, refresh rotation with reuse detection, sessions list / revoke, password reset, e-mail and phone verification, avatar upload (S3 presigned), deactivate / delete with grace period, roles + permissions, super admin CLI | [security](docs/conventions/security.md), [threat model](docs/architecture/security.md)                            |
| **Admin**                               | Users (list, edit, disable, revoke sessions), audit log, notifications broadcast, payments, ops (queues, failed jobs, outbox, live processes)                                                                                                                         | `/api/docs` (Swagger)                                                                                              |
| **Notifications**                       | `Notifier` port: push (FCM), inbox, e-mail; device tokens with pruning; deduped per occurrence; unreachable accounts skipped                                                                                                                                          | [integrations](docs/conventions/integrations.md)                                                                   |
| **Payments** (optional)                 | Stripe checkout, portal, prices; signed webhook → queue → forward-only state                                                                                                                                                                                          | [integrations](docs/conventions/integrations.md#inbound-stripe-webhooks)                                           |
| **Example module** (`modules/examples`) | Notes: CRUD, v1/v2 with sunset, GraphQL, Socket.IO, cron → queue → push reminders, soft delete, cache, port over gRPC — the module `pnpm g:module` copies                                                                                                             | [module README](src/modules/examples/README.md)                                                                    |
| **API contract**                        | Response envelope, error registry with code ranges, human messages, OpenAPI with typed responses, versioning with Deprecation / Sunset                                                                                                                                | [responses](docs/conventions/responses.md), [errors](docs/conventions/errors.md), [messages](docs/api/messages.md) |
| **Realtime**                            | Socket.IO (WebSocket only, Redis adapter, emit from any process), GraphQL subscriptions                                                                                                                                                                               | [socket events](docs/api/socket-events.md), [GraphQL](docs/conventions/graphql.md)                                 |
| **Background work**                     | BullMQ with one policy table, `@LockedCron`, transactional outbox, send-once guard                                                                                                                                                                                    | [queues](docs/conventions/queues.md)                                                                               |
| **Data**                                | MongoDB replica set, repositories, transactions with retries, migrations, index sync, seed                                                                                                                                                                            | [database](docs/conventions/database.md)                                                                           |
| **Time**                                | Injected clock, business day, IANA zones only, DST-safe input, multi-zone test runs                                                                                                                                                                                   | [time](docs/conventions/time.md)                                                                                   |
| **Resilience & ops**                    | Timeouts, circuit breakers, graceful shutdown, health / readiness, heartbeats, pino logs, Sentry, OpenTelemetry                                                                                                                                                       | [fault tolerance](docs/architecture/fault-tolerance.md)                                                            |
| **Services later**                      | Ports between modules, lint-enforced boundaries, gRPC + RabbitMQ behind one transport                                                                                                                                                                                 | [microservices](docs/architecture/microservices.md)                                                                |
| **Deploy**                              | Docker image, docker compose, Render Blueprint, PM2 + nginx for a VPS, CI, Renovate                                                                                                                                                                                   | [deployment](docs/architecture/deployment.md)                                                                      |

Every environment variable is listed, grouped and explained in [`.env.example`](.env.example); the
boot validates them all ([`src/config/env.validation.ts`](src/config/env.validation.ts)).

## Quick start (about 5 minutes)

Needs Node 24, pnpm 11 (`corepack enable`) and Docker.

```bash
git clone https://github.com/PrantaDas/nestjs-keel.git my-api && cd my-api
pnpm install
cp .env.example .env              # works as is for local development
pnpm infra:up                     # MongoDB, Redis ×2, Mailpit, S3 (SeaweedFS), RabbitMQ
pnpm seed                         # optional: staff accounts + 50 people with history (prints passwords once)
pnpm dev:api                      # http://localhost:3000/api/v1, docs at /api/docs
```

Check it:

```bash
curl -s localhost:3000/api/ready | jq .
curl -s -X POST localhost:3000/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","password":"correct-horse-42"}' | jq '.data.accessToken'
```

The other processes, each in its own terminal (or all at once from the image:
`docker compose --profile app up --build`):

```bash
pnpm dev:worker     # jobs: OTP delivery, notifications, reminders, Stripe events, outbox relay
pnpm dev:cron       # schedules (Redis-locked)
pnpm dev:socket     # Socket.IO on :3001
pnpm dev:graphql    # GraphQL on :3002/graphql (GraphiQL in development)
```

**Try every channel at once:** start `pnpm dev:graphql` and `pnpm dev:socket` too, then
`pnpm playground` and open http://localhost:5173. The page signs up over REST, listens on Socket.IO
and a GraphQL subscription, creates notes over REST, GraphQL and Socket.IO, and shows the pushes
arriving; **Run all checks** verifies the lot (12 checks).

Local tools: Mailpit inbox http://localhost:8025, RabbitMQ console http://localhost:15672
(guest/guest). With `OTP_DEV_LOG=true` (the default locally) one-time codes are
printed in the api log instead of sent; set it to `false` to send them through the worker to Mailpit.

## Start your own project from it

1. On GitHub: **Use this template** (or `npx degit PrantaDas/nestjs-keel my-api` for a copy without
   history, then `git init`).
2. Rename it: `name`, `description`, `author`, `repository`, `homepage`, `bugs` in `package.json`;
   `APP_NAME`, `JWT_ISSUER`, `JWT_AUDIENCE` and `MAIL_FROM` in `.env.example` (and their defaults in
   `src/config/env.validation.ts`); `name` in `docker-compose.yml` and `.devcontainer/devcontainer.json`;
   the values in `render.yaml`; the copyright holder in `LICENSE`.
3. Keep the example module (`src/modules/examples`) while you learn the conventions: it is the
   reference `pnpm g:module` copies. Payments switch themselves off without a Stripe key; drop the
   `graphql` or `socket` process from your deployment if no client uses it.
4. Add your first module: `pnpm g:module invoices` ([CONTRIBUTING.md](CONTRIBUTING.md)).

## Processes

| Process | Dev                | Port  | Does                                                     |
| ------- | ------------------ | ----- | -------------------------------------------------------- |
| api     | `pnpm dev:api`     | 3000  | REST `/api/v1`, Swagger `/api/docs`, Stripe webhook      |
| graphql | `pnpm dev:graphql` | 3002  | `/graphql`, subscriptions over `graphql-ws`              |
| socket  | `pnpm dev:socket`  | 3001  | Socket.IO gateways ([events](docs/api/socket-events.md)) |
| worker  | `pnpm dev:worker`  | –     | BullMQ processors, outbox relay, RabbitMQ RPC            |
| cron    | `pnpm dev:cron`    | –     | `@LockedCron` schedules                                  |
| grpc    | `pnpm dev:grpc`    | 50051 | Optional: a module's ports over gRPC                     |

Details: [docs/architecture/processes.md](docs/architecture/processes.md).

## Commands

| Command                                                                | What                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm test` / `pnpm test:tz`                                           | Unit tests (no services) / under four server time zones                              |
| `pnpm test:e2e` / `pnpm test:tz:e2e`                                   | End-to-end against compose services / under two zones                                |
| `pnpm test:smoke`                                                      | Read-only checks of running processes (see [testing](docs/conventions/testing.md))   |
| `pnpm lint` · `pnpm typecheck` · `pnpm format`                         | Quality gates (also run by Husky and CI)                                             |
| `pnpm g:module invoices`                                               | New feature module from the example, wired into every process                        |
| `pnpm migrate status\|up\|down\|create <name>`                         | Data migrations                                                                      |
| `pnpm db:sync-indexes [--apply]`                                       | Compare / create schema indexes (production runs with autoIndex off)                 |
| `pnpm seed [--users 200] [--reset]`                                    | Local data (refuses non-local databases)                                             |
| `pnpm admin:create --email you@example.com`                            | Create a super admin (password prompted, never a flag)                               |
| `pnpm dev:token <userId>`                                              | Access token for a user, for curl, smoke and k6                                      |
| `pnpm openapi:export` · `pnpm messages:export` · `pnpm graphql:schema` | Generated contracts (tests fail when stale)                                          |
| `pnpm proto:gen` · `pnpm proto:lint`                                   | gRPC types from `proto/`                                                             |
| `pnpm playground`                                                      | Browser page on :5173 exercising REST, GraphQL, subscriptions and Socket.IO together |
| `pnpm infra:up` · `pnpm infra:down`                                    | Local services                                                                       |

## Deploy

| Target                 | Start here                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Render                 | `render.yaml` → Dashboard → New → Blueprint ([guide](docs/architecture/deployment.md#render))                                            |
| Ubuntu VPS             | `ecosystem.config.cjs` (PM2) + `sudo deploy/vps/setup-nginx.sh <domain> <email>` ([guide](docs/architecture/deployment.md#vps-with-pm2)) |
| Any container platform | `Dockerfile`, one image, start command per process ([guide](docs/architecture/deployment.md))                                            |

## Layout

```
src/
  main.<process>.ts   entry points          app/          one root module per process + CoreModule
  config/             env schema + typed config            bootstrap/    HTTP hardening, shutdown
  common/             auth, errors, messages, time, contracts (ports between modules)
  infra/              database, redis, cache, queue, cron, realtime, graphql, events/outbox, transport, …
  integrations/       S3, mail, SMS, push, Stripe behind ports + resilience
  modules/            identity, notifications, payments, ops, audit, examples (the module to copy)
  migrations/ cli/    data migrations, CLI tools
proto/                gRPC contracts               deploy/vps/   nginx site + setup script
test/                 unit contracts, e2e, smoke, k6
docs/                 architecture, conventions, ADRs, API catalogues
render.yaml           Render Blueprint             ecosystem.config.cjs   PM2 (VPS)
```

## Documentation

- Architecture: [overview](docs/architecture/overview.md) · [processes](docs/architecture/processes.md)
  · [fault tolerance](docs/architecture/fault-tolerance.md) · [security](docs/architecture/security.md)
  · [microservices](docs/architecture/microservices.md) · [deployment](docs/architecture/deployment.md)
- Conventions: [responses](docs/conventions/responses.md) · [errors](docs/conventions/errors.md)
  · [messages](docs/conventions/messages.md) · [time](docs/conventions/time.md)
  · [database](docs/conventions/database.md) · [queues](docs/conventions/queues.md)
  · [security](docs/conventions/security.md) · [integrations](docs/conventions/integrations.md)
  · [GraphQL](docs/conventions/graphql.md) · [versioning](docs/conventions/versioning.md)
  · [testing](docs/conventions/testing.md)
- Decisions: [docs/adr](docs/adr/README.md) · API catalogues: [messages](docs/api/messages.md),
  [socket events](docs/api/socket-events.md), OpenAPI at `/api/docs`, GraphQL [schema.gql](schema.gql)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · for coding agents: [AGENTS.md](AGENTS.md)

## Troubleshooting

| Symptom                                                    | Fix                                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Boot stops with a list of env problems                     | Read the list; compare with `.env.example`                                                                 |
| `/api/ready` says `mongodb: down`                          | `pnpm infra:up`; the URI must include `directConnection=true` locally (replica set)                        |
| Port 27047 / 6389 / 6390 in use                            | Another compose project: `docker ps`, or change the host port in `docker-compose.yml` and `.env`           |
| `ERR_REQUIRE_ESM` or "Cannot use import statement" in Jest | Run tests through `pnpm test` (sets `--experimental-vm-modules`)                                           |
| E2E fails with "refuses a remote database"                 | `MONGO_URI` points off this machine; tests only run locally                                                |
| Codes never arrive                                         | With `OTP_DEV_LOG=true` they are in the api log; otherwise start `pnpm dev:worker` (it sends them)         |
| Uploads fail with "not set up yet"                         | `S3_BUCKET` empty, or `s3-init` did not run: `docker compose up s3-init`                                   |
| Payments routes answer "not set up yet"                    | Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (see [integrations](docs/conventions/integrations.md)) |
| `docker compose --profile app up` fails at boot            | It reads `.env` for secrets (copy `.env.example`); compose itself points the URLs at the service names     |

## License

[MIT](LICENSE) © Pranta Das
