# Architecture overview

A modular monolith on NestJS 12 that ships as **one codebase and one Docker image** and runs as
five independent processes. Each process boots its own root module and shares one `CoreModule`.

```
            ┌───────────────────── one codebase, one image ─────────────────────┐
 clients ──▶│ api (REST /api/v1, Swagger)      graphql (/graphql, ws subscriptions)│◀── clients
 clients ──▶│ socket (Socket.IO, Redis adapter)                                     │
            │      │ enqueue / outbox                ▲ emit via Redis (emitter)     │
            │      ▼                                 │                              │
            │ worker (BullMQ consumers, outbox relay) ┘    cron (@LockedCron, 1+)   │
            └───────────────┬─────────────────────────────────┬────────────────────┘
                            ▼                                 ▼
                 MongoDB replica set               Redis core (noeviction): queues, locks,
                 (transactions, outbox)            sessions, OTP, rate limits, pub/sub
                                                   Redis cache (allkeys-lru, optional)
```

| Process         | Entry                 | Root module        | Serves                                   | Port                  |
| --------------- | --------------------- | ------------------ | ---------------------------------------- | --------------------- |
| api             | `src/main.api.ts`     | `ApiModule`        | REST (`/api/v1/...`), Swagger, health    | `API_PORT` (3000)     |
| graphql         | `src/main.graphql.ts` | `GraphqlAppModule` | `/graphql` (HTTP + `graphql-ws`), health | `GRAPHQL_PORT` (3002) |
| socket          | `src/main.socket.ts`  | `SocketModule`     | Socket.IO gateways, health               | `SOCKET_PORT` (3001)  |
| worker          | `src/main.worker.ts`  | `WorkerModule`     | BullMQ processors, outbox relay          | none                  |
| cron            | `src/main.cron.ts`    | `CronModule`       | `@LockedCron` jobs                       | none                  |
| grpc (optional) | `src/main.grpc.ts`    | `GrpcAppModule`    | gRPC server for extracted modules        | `GRPC_PORT` (50051)   |

The same image runs all of them; the start command picks one (`node dist/main.<process>.js`).

## Layers

```
src/
  main.*.ts      entry points: force UTC → Sentry/OTel instrument → process handlers → boot
  app/           one root module per process + core.module.ts (shared infrastructure)
  bootstrap/     app factories, HTTP hardening, graceful shutdown, fatal-error handlers
  config/        Joi env schema (boot fails fast) + typed registerAs namespaces
  common/        framework-level building blocks with no business rules:
                 auth (tokens, guards), context (AsyncLocalStorage), contracts (cross-module ports),
                 exceptions + error registry, messages, pipes, swagger helpers, time, safety
  infra/         technical services: database, redis, cache, queue, cron, realtime, health,
                 heartbeat, lifecycle, logger, security, sentry, telemetry, events/outbox, transport
  integrations/  outbound providers behind ports: s3, mail, sms, push, stripe + resilience
  modules/       feature modules (identity: auth, users, sessions, OTP; notifications, payments, ops, audit, examples)
  migrations/    data migration runner and scripts
  cli/           migrate, sync-indexes, seed, create-super-admin, dev-token, exports
```

Dependency rule (enforced by ESLint `no-restricted-imports`):

- `common` imports nothing from `infra`, `integrations` or `modules` (except type-only time/context helpers).
- `infra` and `integrations` never import `modules`.
- `modules/<a>` never imports `modules/<b>/**`. Cross-module calls go through an abstract class in
  `src/common/contracts/` that the owning module provides (`{ provide: UserDirectory, useExisting: UsersService }`).

## Contracts that every layer relies on

| Contract                                                                          | Where                                                    | Doc                                      |
| --------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------- |
| Success envelope `{ success, message, data, meta? }`                              | `common/interceptors/response-envelope.interceptor.ts`   | [responses](../conventions/responses.md) |
| Error envelope `{ success, errorCode, error, errorMessage, details?, requestId }` | `common/exceptions/exception-mapper.ts`                  | [errors](../conventions/errors.md)       |
| Error registry `defineErrors(domain, [min, max], …)`                              | `common/exceptions/error-registry.ts`                    | [errors](../conventions/errors.md)       |
| Human messages                                                                    | `common/messages`, `common/pipes/validation-messages.ts` | [messages](../conventions/messages.md)   |
| Time (`Clock`, `TimeService`, `DayKey`, business zone)                            | `common/time`                                            | [time](../conventions/time.md)           |
| Queue policy table                                                                | `infra/queue/queue-policies.ts`                          | [queues](../conventions/queues.md)       |
| Ports between modules                                                             | `common/contracts`                                       | [microservices](microservices.md)        |

## Request lifecycle (REST)

1. `HttpTraffic` middleware: request timeout, in-flight tracking for the shutdown drain, client aborts.
2. `RequestContext` middleware (AsyncLocalStorage): request id, IP, user agent, locale, device zone.
3. Helmet, compression, CORS, body parsers with per-route-type limits (the Stripe webhook keeps its raw body).
4. Input sanitiser (strips `$`/`.` operator keys from bodies and queries).
5. Guards: `JwtAuthGuard` (token + live session, or API key) → `RolesGuard` (roles + permissions) → throttler.
6. `ValidationPipe` (whitelist, transform, human messages).
7. Interceptors: idempotency key, deprecation headers, audit, response envelope.
8. Handler → service → repository.
9. `AllExceptionsFilter` maps anything thrown to the error envelope, logs, reports to Sentry.

## Data and events

- MongoDB through Mongoose 9. Services use repositories (`BaseRepository<T>`), never models.
- Writes that must produce an event write an **outbox** row in the same transaction
  (`OutboxService.add(event, session)`); the worker's relay publishes it to in-process handlers
  and, when configured, to the message transport. Events survive a crash between commit and publish.
- Heavy or fan-out work runs in BullMQ jobs. Every queue has a row in the policy table.

## Build order (vertical slices, each ends green and committed)

1. Config and bootstrap (entry points, process model, graceful shutdown, health)
2. Envelopes, error registry, messages (and the message guard test)
3. Time (clock, TimeService, validators, ESLint rules, multi-zone tests)
4. Database and repository (connection supervisor, transactions, pagination, indexes, migrations)
5. Auth and users (tokens with rotation, Redis sessions, OTP, users/admins, super admin CLI)
6. Example module complete with tests (`modules/examples` – notes)
7. Queues, cron, realtime (policies, `BaseProcessor`, `@LockedCron`, gateways, emitter)
8. Integrations (S3, mail, SMS, push + notifications module, resilience)
9. GraphQL (code-first, dataloaders, limits, subscriptions)
10. Stripe (checkout, portal, webhook through a queue)
11. Transport (outbox relay, gRPC, RabbitMQ)
12. Ops, docs, CI, Docker, devcontainer, generator, seed, smoke and load tests

Progress is logged in [progress.md](progress.md).
