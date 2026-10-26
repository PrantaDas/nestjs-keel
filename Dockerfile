# syntax=docker/dockerfile:1.7
# One image for every run mode; the start command picks the mode:
#   node --enable-source-maps dist/main.api.js | main.socket.js | main.worker.js | main.cron.js

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod --ignore-scripts
# Files Node never loads at runtime: dependency source maps (ours in dist/ stay), type
# declarations and docs. About half of node_modules; licences are kept.
RUN find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
      -o \( -name '*.md' ! -iname 'license*' \) \) -delete

FROM node:24-alpine AS runtime
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
# tini (PID 1) forwards SIGTERM to node, whose graceful shutdown finishes within SHUTDOWN_TIMEOUT_MS
# (default 25 s). Keep the platform stop timeout above it: ECS stopTimeout 30, `docker stop -t 30`.
# No HEALTHCHECK: one image serves four modes and worker/cron have no HTTP port; api/socket use
# /api/health (liveness, container restarts) and /api/ready (load balancer routing). See README.
ENV SHUTDOWN_TIMEOUT_MS=25000
STOPSIGNAL SIGTERM
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.api.js"]
