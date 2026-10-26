# Deployment

One image (`Dockerfile`), several services started from it with different commands. Any container
platform works (Kubernetes, ECS, Fly, Render, Docker on a VM); nothing is tied to one.

## Build

```bash
docker build -t app:$(git rev-parse --short HEAD) .
```

Multi-stage: dependencies and build with pnpm, then a slim runtime with production dependencies only,
`tini` as PID 1, user `node`, `STOPSIGNAL SIGTERM`. About 330 MB. Set the `RELEASE` env var to the image's
git SHA at deploy time so logs, Sentry and traces carry it.

## Services

| Service | Command                                      | Replicas                     | Probes                                                                                      |
| ------- | -------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| api     | `node --enable-source-maps dist/main.api.js` | 2+                           | liveness `GET /api/health`, readiness `GET /api/ready` on `API_PORT`                        |
| graphql | `… dist/main.graphql.js`                     | 2+ (if used)                 | same paths on `GRAPHQL_PORT`                                                                |
| socket  | `… dist/main.socket.js`                      | 2+ (if used)                 | same paths on `SOCKET_PORT`; WebSocket upgrade allowed at the balancer; idle timeout ≥ 60 s |
| worker  | `… dist/main.worker.js`                      | 1+ (scale on queue depth)    | none (heartbeat in ops; process exit = restart)                                             |
| cron    | `… dist/main.cron.js`                        | 1–2                          | none (heartbeat)                                                                            |
| grpc    | `… dist/main.grpc.js`                        | only for an extracted module | TCP on `GRPC_PORT`                                                                          |

**Stop timeout ≥ 30 s** on every service (Kubernetes `terminationGracePeriodSeconds: 30`, ECS
`stopTimeout: 30`, `docker stop -t 30`): the app finishes within `SHUTDOWN_TIMEOUT_MS` (25 s). If
the balancer polls readiness slowly, set `SHUTDOWN_DRAIN_DELAY_MS` to its interval and raise both
timeouts accordingly.

Behind a proxy set `TRUST_PROXY` to the number of hops (one load balancer = 1) so rate limits and
audit see real client IPs.

## Release steps

```bash
# 1. before the new version takes traffic (one-off task with the new image)
node dist/cli/migrate.js up             # data migrations (pnpm migrate:dist up)
node dist/cli/sync-indexes.js --apply   # create new indexes (MONGO_AUTO_INDEX=false in production)
# 2. roll the services (api/graphql/socket by readiness, then worker and cron)
# 3. smoke test the deployment
SMOKE_API_URL=https://api.example.com SMOKE_USER_TOKEN=… SMOKE_ADMIN_TOKEN=… pnpm test:smoke
```

Migrations must be compatible with the previous version still running (expand, deploy, contract).
First deploy only: `node dist/cli/create-super-admin.js --email …` (prompts for the password
without echo, or `--generate` prints a strong one once; never put a password on a command line).

## Production configuration

- `NODE_ENV=production`; secrets from a secret manager; `SWAGGER_ENABLED=false`;
  `GRAPHQL_INTROSPECTION` empty (off); `LOG_PRETTY=false` (JSON logs); `MONGO_AUTO_INDEX=false`.
- MongoDB replica set (Atlas or self-hosted), Redis core with `maxmemory-policy noeviction`
  (queues and sessions must never be evicted) and persistence; Redis cache with `allkeys-lru`.
- `SENTRY_DSN`, `RELEASE`; `OTEL_ENABLED=true` with `OTEL_EXPORTER_OTLP_ENDPOINT` for traces and
  metrics.
- The env schema stops the boot with a readable list of problems on a missing or unsafe value.

## Rollback

Redeploy the previous image. Run `migrate down` only for a migration that cannot coexist with the old
code (rare when following expand/contract). Indexes added by `--apply` are harmless to old code.
