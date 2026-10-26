# Processes

One image, six entry points. Each process boots its own root module on top of the shared
`CoreModule` and can be scaled on its own. ADR: [0001](../adr/0001-modular-monolith-and-process-model.md).

| Process         | Start (image)               | Dev                | Port                | Scale                                                                                         | Health                          |
| --------------- | --------------------------- | ------------------ | ------------------- | --------------------------------------------------------------------------------------------- | ------------------------------- |
| api             | `node dist/main.api.js`     | `pnpm dev:api`     | `API_PORT` 3000     | horizontally, behind a load balancer                                                          | `/api/health`, `/api/ready`     |
| graphql         | `node dist/main.graphql.js` | `pnpm dev:graphql` | `GRAPHQL_PORT` 3002 | horizontally (sticky not needed: `graphql-ws` state is per socket, events via Redis)          | same paths                      |
| socket          | `node dist/main.socket.js`  | `pnpm dev:socket`  | `SOCKET_PORT` 3001  | horizontally, no sticky sessions (WebSocket-only transport, broadcasts via the Redis adapter) | same paths                      |
| worker          | `node dist/main.worker.js`  | `pnpm dev:worker`  | none                | by queue depth; concurrency per queue in the policy table                                     | heartbeat (ops)                 |
| cron            | `node dist/main.cron.js`    | `pnpm dev:cron`    | none                | 1 is enough; 2 for availability (Redis locks: one run per tick)                               | heartbeat (ops)                 |
| grpc (optional) | `node dist/main.grpc.js`    | `pnpm dev:grpc`    | `GRPC_PORT` 50051   | horizontally                                                                                  | gRPC health via deadline errors |

`/api/health` is liveness (the process answers: restart it if not). `/api/ready` is readiness
(MongoDB and core Redis reachable, not shutting down: route traffic to it); the cache Redis being
down is reported but does not make it unready. Every process writes a heartbeat to Redis every 30 s
(TTL 95 s); `GET /api/v1/admin/ops/processes` lists the live ones, and the smoke test checks them.

## What each process needs

All processes read the same validated environment (`.env.example`, one schema), so one config
works for all. What actually matters per process:

| Env group                                   |         api         | graphql | socket |  worker   | cron |   grpc   |
| ------------------------------------------- | :-----------------: | :-----: | :----: | :-------: | :--: | :------: |
| App, time, logging, MongoDB, core Redis     |          ✓          |    ✓    |   ✓    |     ✓     |  ✓   |    ✓     |
| Cache Redis (optional)                      |          ✓          |    ✓    |   ✓    |     ✓     |  ✓   |    ✓     |
| JWT secrets (verify tokens), `API_KEYS`     |          ✓          |    ✓    |   ✓    |     –     |  –   |    –     |
| OTP, throttle, idempotency                  |          ✓          |    ✓    |   –    |     –     |  –   |    –     |
| `SOCKET_*` (server)                         |          –          |    –    |   ✓    |     –     |  –   |    –     |
| `GRAPHQL_*`                                 |          –          |    ✓    |   –    |     –     |  –   |    –     |
| S3                                          |      ✓ presign      |    ✓    |   –    | ✓ deletes |  –   |    –     |
| SMTP, Twilio, FCM                           |          –          |    –    |   –    |     ✓     |  –   |    –     |
| Stripe                                      | ✓ checkout, webhook |    –    |   –    | ✓ events  |  –   |    –     |
| Outbox relay, RabbitMQ RPC server           |          –          |    –    |   –    |     ✓     |  –   |    –     |
| `TRANSPORT_ROUTES`, `GRPC_*` (port clients) |          ✓          |    ✓    |   ✓    |     ✓     |  ✓   | ✓ server |
| `SHUTDOWN_*`                                |          ✓          |    ✓    |   ✓    |     ✓     |  ✓   |    ✓     |
| `REQUEST_TIMEOUT_*`, `HTTP_KEEP_ALIVE_*`    |          ✓          |    ✓    |   ✓    |     –     |  –   |    –     |

The schema validates the same variables in every process (the JWT secrets are required
everywhere), so one secret set serves all; "–" means the process does not use the value.
Providers never block a request: the api enqueues and the worker talks to SMTP, Twilio and FCM, so
only the worker needs those credentials in production (others may have them empty).

## Who does what

```
request ─▶ api / graphql / socket ── validates, authorises, writes MongoDB (+ outbox, same txn)
                │                      enqueues BullMQ jobs, emits socket events via Redis
                ▼
              worker ── processes jobs (OTP delivery, notifications, reminders, Stripe events),
                        relays the outbox to @OnDomainEvent handlers (and RabbitMQ), RPC server
              cron ──── finds due work on a schedule (Redis-locked) and enqueues it
```

## Starting everything locally

```bash
pnpm infra:up                         # MongoDB, Redis ×2, Mailpit, S3, RabbitMQ
pnpm dev                              # api, graphql, socket, worker, cron: one compiler, restarts on change
pnpm dev api graphql socket           # only some (one command: never two `pnpm dev` at once)
# or, from the built image:
docker compose --profile app up --build
```
