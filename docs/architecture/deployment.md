# Deployment

One codebase, several processes. Two ready-made targets ship with the repo:

| Target                        | Files                                                             | Good for                                                  |
| ----------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| [Render](#render)             | `render.yaml` (Blueprint)                                         | Managed: no servers, zero-downtime deploys, private Redis |
| [VPS with PM2](#vps-with-pm2) | `ecosystem.config.cjs`, `deploy/vps/` (nginx site + setup script) | One machine you control, lowest cost                      |

Any other container platform (Kubernetes, ECS, Fly, Docker on a VM) runs the same image with the
commands below; nothing is tied to one.

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

## Render

`render.yaml` is a [Blueprint](https://render.com/docs/blueprint-spec): api, graphql and socket as web
services, worker and cron as background workers, all built from the `Dockerfile`, plus two Key Value
(Redis) instances (`redis-core` with `noeviction`, `redis-cache` with `allkeys-lru`) reachable only
over the private network. It validates against Render's published schema.

**Before:** a MongoDB replica set reachable from Render (MongoDB Atlas; allow Render's outbound IPs
or `0.0.0.0/0` with a strong password), and the web app URL. Optional: S3 bucket, SMTP, Twilio, FCM,
Stripe, Sentry.

1. Push the repository to GitHub or GitLab.
2. Render dashboard → **New → Blueprint** → pick the repository. Render reads `render.yaml`.
3. Fill the prompted values: `MONGO_URI` and `APP_WEB_URL` are required; leave the optional
   integrations empty to keep them off. `JWT_*_SECRET` are generated once by Render.
4. Apply. Each deploy builds the image, runs the **pre-deploy command** on the api service
   (`migrate up` + `sync-indexes --apply`), then switches instances once `/api/ready` answers.
5. First deploy only, from the api service's **Shell** tab:
   `node dist/cli/create-super-admin.js --email you@example.com` (the password prompt does not echo).
6. Point clients at the `*.onrender.com` URLs (or add custom domains): REST at
   `https://<api>/api/v1`, GraphQL at `https://<graphql>/graphql`, sockets at `https://<socket>` with
   `transports: ['websocket']`. Stripe webhook endpoint: `https://<api>/api/webhooks/stripe`.
7. Smoke test from your machine: `SMOKE_API_URL=https://<api> SMOKE_GRAPHQL_URL=https://<graphql>
SMOKE_SOCKET_URL=https://<socket> SMOKE_USER_TOKEN=… SMOKE_ADMIN_TOKEN=… pnpm test:smoke`.

Notes:

- Paid plans (`starter`+) are needed for background workers, pre-deploy commands and Redis
  persistence. Keep every resource in one region.
- `maxShutdownDelaySeconds: 30` leaves room for the 25 s graceful shutdown.
- Scale with `numInstances` (or autoscaling) per service. Sockets need no sticky sessions: the
  server accepts WebSocket only and broadcasts cross instances through `redis-core`.
- Every service builds the same Dockerfile. To build once, push the image from CI to a registry
  and switch the services to `runtime: image` with `image.url`.
- Set `RELEASE` to the commit if you want it on logs and Sentry events (Render exposes
  `RENDER_GIT_COMMIT` to builds and services; copy it into `RELEASE` in a custom start script, or
  set it in the dashboard).
- Without a Stripe key, the payments worker and webhook are not registered; ops shows the
  `stripe-events` queue as disabled, and the smoke test ignores it.

## VPS with PM2

One Linux machine (Ubuntu 24.04 LTS assumed): nginx terminates TLS and routes to the three HTTP
processes, which PM2 runs from the compiled `dist/` and binds to `127.0.0.1` only
(`LISTEN_HOST`, set in `ecosystem.config.cjs`).

```
internet ─▶ nginx :443 ─┬─ /api/*        ─▶ api      127.0.0.1:3000  (PM2 cluster, 2 instances)
                        ├─ /graphql      ─▶ graphql  127.0.0.1:3002  (PM2 cluster)
                        └─ /socket.io/*  ─▶ socket   127.0.0.1:3001  (PM2 cluster, WebSocket only)
                           worker, cron (PM2 fork) ─ no ports
MongoDB replica set + Redis core + Redis cache: managed, or on this machine bound to 127.0.0.1
```

Checked locally: all processes online under PM2 in production mode, listeners on `127.0.0.1` only,
`pm2 reload api` under a request loop (4742 requests, none failed), REST, GraphQL and Socket.IO
through `deploy/vps/nginx.conf` with TLS, client IP spoofing ignored, socket connections spread over
two cluster workers with every push delivered, every process "shut down cleanly" on stop.

### 1. Server, once

```bash
# as root: a deploy user, firewall, nginx, certbot
adduser --disabled-password deploy && usermod -aG sudo deploy
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable       # 3000-3002 stay closed
apt install -y git                                           # nginx: see setup-nginx.sh below
# as deploy: Node 24, pnpm (corepack), PM2
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 24
corepack enable
npm install -g pm2@7.0.4
pm2 startup systemd            # prints one sudo command: run it, so PM2 starts on boot
pm2 install pm2-logrotate      # rotate the JSON logs in ~/.pm2/logs
```

**Data services.** Use managed ones (MongoDB Atlas, a managed Redis) if you can. On the same machine:

- MongoDB 8 as a single-node **replica set** (transactions need it): `replication.replSetName: rs0`,
  `net.bindIp: 127.0.0.1`, auth on; run `rs.initiate()` once. `MONGO_URI` like
  `mongodb://app:…@127.0.0.1:27017/app?replicaSet=rs0&authSource=admin`.
- Two Redis instances bound to `127.0.0.1` with a password: core (`maxmemory-policy noeviction`,
  `appendonly yes`) for `REDIS_URL`, cache (`maxmemory 256mb`, `allkeys-lru`, no persistence) for
  `REDIS_CACHE_URL`. One instance must never evict; that is why there are two.

### 2. First deploy

From your machine (the server needs read access to the repository, e.g. a deploy key):

```bash
export DEPLOY_HOST=203.0.113.10 DEPLOY_USER=deploy DEPLOY_REPO=git@github.com:you/your-repo.git
pm2 deploy ecosystem.config.cjs production setup     # clones into /srv/app/source
```

On the server, create `/srv/app/shared/.env` from `.env.example` (`chmod 600`): `NODE_ENV=production`,
real `JWT_*_SECRET` (`openssl rand -base64 48`, two different values), `MONGO_URI`, `REDIS_URL`,
`REDIS_CACHE_URL`, `CORS_ORIGINS`, `APP_WEB_URL`, `OTP_DEV_LOG=false`, `MONGO_AUTO_INDEX=false`,
`SWAGGER_ENABLED=false`, `LOG_PRETTY=false`, `TRUST_PROXY=1`, and the integrations you use. The boot
refuses placeholder secrets.

```bash
pm2 deploy ecosystem.config.cjs production           # install, build, migrate, indexes, start, save
```

nginx and TLS, one command (DNS for the domain must already point at the server):

```bash
sudo /srv/app/current/deploy/vps/setup-nginx.sh api.example.com you@example.com
```

It installs nginx and certbot when missing, serves the Let's Encrypt challenge over HTTP, gets the
certificate, installs `deploy/vps/nginx.conf` with your domain (and `API_PORT`, `GRAPHQL_PORT`,
`SOCKET_PORT` if you changed them), checks it with `nginx -t`, reloads, and makes certificate renewals
reload nginx. Rerun it any time; the certificate is kept. No DNS yet? `SELF_SIGNED=1` installs a
throwaway certificate so everything else can be tested. Tested on Ubuntu 24.04 (nginx 1.24).

| Path           | Process         | Notes                                                          |
| -------------- | --------------- | -------------------------------------------------------------- |
| `/api/*`       | api `:3000`     | REST, `/api/health`, `/api/ready`, Stripe webhook; 1 MB bodies |
| `/graphql`     | graphql `:3002` | queries and `graphql-ws` subscriptions                         |
| `/socket.io/*` | socket `:3001`  | WebSocket upgrade, 1 h idle                                    |
| anything else  | –               | 404                                                            |

Then, once: `cd /srv/app/current && node dist/cli/create-super-admin.js --email you@example.com`.

### 3. Every release

```bash
pm2 deploy ecosystem.config.cjs production           # pulls, builds, migrates, reloads
```

The post-deploy hook stops at the first failing step (install, build, migration), leaving the
running version untouched. `pm2 startOrReload` then reloads api, graphql and socket one instance at
a time (zero downtime); worker and cron restart after their graceful shutdown (jobs finish first;
`kill_timeout` is 30 s, PM2's default of 1.6 s would cut jobs off).

- Rollback: `pm2 deploy ecosystem.config.cjs production revert 1`.
- Status and logs: `pm2 ls`, `pm2 logs api --lines 100`, `pm2 monit`.
- Scale: `API_INSTANCES`, `GRAPHQL_INSTANCES`, `SOCKET_INSTANCES`, `WORKER_INSTANCES` (numbers or
  `max`) in the environment of the shell that runs `pm2 startOrReload`.
- Smoke test on the server: `SMOKE_API_URL=http://127.0.0.1:3000 SMOKE_GRAPHQL_URL=http://127.0.0.1:3002
SMOKE_SOCKET_URL=http://127.0.0.1:3001 SMOKE_USER_TOKEN=… SMOKE_ADMIN_TOKEN=… pnpm test:smoke`.

Without `pm2 deploy`: `git pull`, then run the same steps as the `post-deploy` line in
`ecosystem.config.cjs` from the app directory.
