/*
 * PM2 process file for a VPS: every process from the compiled `dist/`, behind nginx.
 * Guide (server setup, first deploy, updates, rollback): docs/architecture/deployment.md#vps-with-pm2
 *
 *   pm2 startOrReload ecosystem.config.cjs     start, or reload with zero downtime (cluster apps)
 *   pm2 deploy ecosystem.config.cjs production setup | (no arg: deploy) | revert 1
 *
 * Configuration comes from `.env` in the app directory (loaded by the app itself, real environment
 * variables win), so PM2 holds no secrets. Instance counts can be tuned without editing this file:
 * API_INSTANCES, GRAPHQL_INSTANCES, SOCKET_INSTANCES, WORKER_INSTANCES ("max" = one per CPU).
 */
const DEPLOY_PATH = process.env.DEPLOY_PATH ?? '/srv/app';

const instances = (name, fallback) => {
  const value = process.env[name];
  if (!value) return fallback;
  return value === 'max' ? 'max' : Number(value);
};

/** What every process shares. */
const base = {
  cwd: __dirname,
  node_args: '--enable-source-maps',
  // The app shuts down gracefully within SHUTDOWN_TIMEOUT_MS (25 s): readiness off, requests and
  // jobs finish, locks released. PM2's default (1.6 s) would SIGKILL mid-job; give it 30 s.
  kill_timeout: 30_000,
  // A crash loop backs off instead of hammering MongoDB / Redis on every restart.
  exp_backoff_restart_delay: 200,
  max_memory_restart: '1G',
  // Logs are JSON lines from pino; one file per app (rotate with pm2-logrotate).
  merge_logs: true,
  time: false,
  env: {
    NODE_ENV: 'production',
    // Only nginx (same machine) reaches the listeners.
    LISTEN_HOST: '127.0.0.1',
  },
};

module.exports = {
  apps: [
    {
      ...base,
      name: 'api',
      script: 'dist/main.api.js',
      // Stateless HTTP: PM2 cluster mode shares API_PORT across instances and reloads them one
      // at a time on `pm2 reload` (zero downtime).
      exec_mode: 'cluster',
      instances: instances('API_INSTANCES', 2),
    },
    {
      ...base,
      name: 'graphql',
      script: 'dist/main.graphql.js',
      exec_mode: 'cluster',
      instances: instances('GRAPHQL_INSTANCES', 1),
    },
    {
      ...base,
      name: 'socket',
      script: 'dist/main.socket.js',
      // WebSocket-only transport: one connection per client, so cluster mode needs no sticky
      // sessions; broadcasts reach every instance through the Redis adapter.
      exec_mode: 'cluster',
      instances: instances('SOCKET_INSTANCES', 1),
    },
    {
      ...base,
      name: 'worker',
      script: 'dist/main.worker.js',
      exec_mode: 'fork',
      instances: instances('WORKER_INSTANCES', 1),
    },
    {
      ...base,
      name: 'cron',
      script: 'dist/main.cron.js',
      // Redis locks make extra instances harmless, but one is enough.
      exec_mode: 'fork',
      instances: 1,
    },
    // Only when a module's ports are served over gRPC (docs/architecture/microservices.md):
    // { ...base, name: 'grpc', script: 'dist/main.grpc.js', exec_mode: 'fork', instances: 1 },
  ],

  /*
   * `pm2 deploy` over SSH: clones into <path>/source, keeps <path>/shared across releases and points
   * <path>/current at the new one. Set DEPLOY_HOST, DEPLOY_USER, DEPLOY_REPO (and DEPLOY_REF) in
   * the shell that runs it. `.env` lives in <path>/shared/.env (created once by hand, mode 600).
   */
  deploy: {
    production: {
      user: process.env.DEPLOY_USER ?? 'deploy',
      host: [process.env.DEPLOY_HOST ?? 'example.com'],
      ref: process.env.DEPLOY_REF ?? 'origin/main',
      repo: process.env.DEPLOY_REPO ?? 'git@github.com:your-org/your-repo.git',
      path: DEPLOY_PATH,
      'pre-setup': `mkdir -p ${DEPLOY_PATH}/shared`,
      // Build, migrate and index before the reload; any failing step stops the deploy with the
      // old version still running.
      'post-deploy': [
        `ln -sfn ${DEPLOY_PATH}/shared/.env .env`,
        'corepack enable',
        // Dev dependencies are needed to build, even if the shell exports NODE_ENV=production.
        'pnpm install --frozen-lockfile --prod=false',
        'pnpm build',
        'node dist/cli/migrate.js up',
        'node dist/cli/sync-indexes.js --apply',
        'pm2 startOrReload ecosystem.config.cjs --update-env',
        'pm2 save',
      ].join(' && '),
    },
  },
};
