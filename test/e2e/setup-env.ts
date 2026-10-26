import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { assertLocalMongoUri } from '@/common/safety/local-only';

// Same infrastructure as local dev (docker compose), isolated database and Redis key prefix.
// E2E_ID isolates parallel runs (e.g. one per git worktree): E2E_ID=notes → db app_e2e_notes.
// Each Jest worker gets its own database and prefix too (…_w2), so test files run in parallel
// workers without seeing each other's data.
const fileEnv = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
const base = { ...fileEnv, ...process.env };
const id = (base.E2E_ID ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const worker = (process.env.JEST_WORKER_ID ?? '').replace(/\D/g, '');
const suffix = [id, worker ? `w${worker}` : '']
  .filter(Boolean)
  .map((part) => `_${part}`)
  .join('');

const mongoUri = base.MONGO_URI ?? 'mongodb://localhost:27047/app?directConnection=true';
// e2e drops and rebuilds its databases: never let that reach a real cluster.
assertLocalMongoUri(mongoUri, 'e2e tests');
const mongo = new URL(mongoUri);
mongo.pathname = `/app_e2e${suffix}`;

process.env = {
  ...base,
  NODE_ENV: 'test',
  MONGO_URI: mongo.toString(),
  MONGO_AUTO_INDEX: 'true',
  REDIS_URL: base.REDIS_URL ?? 'redis://localhost:6389',
  REDIS_CACHE_URL: base.REDIS_CACHE_URL ?? 'redis://localhost:6390',
  REDIS_KEY_PREFIX: `e2e${suffix.replaceAll('_', '-')}:`,
  // A zone that is never the server's (UTC), so a day computed in the wrong zone shows up.
  BUSINESS_TIMEZONE: 'Asia/Dubai',
  LOG_LEVEL: 'silent',
  LOG_PRETTY: 'false',
  SWAGGER_ENABLED: 'false',
  SENTRY_DSN: '',
  OTEL_ENABLED: 'false',
  THROTTLE_LIMIT: '10000',
  THROTTLE_AUTH_LIMIT: '10000',
  THROTTLE_OTP_LIMIT: '10000',
  // Integrations are faked in e2e (test/e2e/fakes.ts): these values only mark them as configured,
  // nothing is ever sent to these hosts, and real credentials must never be used.
  SMTP_HOST: 'smtp.e2e.invalid',
  TWILIO_ACCOUNT_SID: 'ACe2e00000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'e2e-not-a-real-token',
  TWILIO_FROM: '+15005550006',
  OTP_DEV_LOG: 'false',
  OTP_RESEND_COOLDOWN_SECONDS: '0',
  FIREBASE_CREDENTIALS_JSON: '',
  FIREBASE_CREDENTIALS_FILE: '',
  S3_BUCKET: 'e2e-bucket',
  STRIPE_SECRET_KEY: 'sk_test_e2e_not_a_real_key',
  STRIPE_WEBHOOK_SECRET: 'whsec_e2e_not_a_real_secret',
  RABBITMQ_URL: '',
  TRANSPORT_ROUTES: '',
  EVENTS_EXTERNAL: 'none',
  JWT_ACCESS_SECRET: base.JWT_ACCESS_SECRET || 'e2e-access-secret-that-is-at-least-32-chars',
  JWT_REFRESH_SECRET: base.JWT_REFRESH_SECRET || 'e2e-refresh-secret-that-is-at-least-32-chars',
};
