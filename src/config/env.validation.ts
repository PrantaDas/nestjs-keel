import Joi from 'joi';

const optionalString = Joi.string().allow('').default('');
const optionalUri = (schemes: string[]) => Joi.string().uri({ scheme: schemes }).allow('').default('');
const ms = (min: number, max: number, fallback: number) => Joi.number().integer().min(min).max(max).default(fallback);

/** `name=<sha256 hex>` pairs, comma separated (see docs/conventions/security.md "API keys"). */
const API_KEYS_PATTERN =
  /^\s*[a-z0-9][a-z0-9_-]*\s*=\s*[a-f0-9]{64}\s*(,\s*[a-z0-9][a-z0-9_-]*\s*=\s*[a-f0-9]{64}\s*)*$/i;

/** IANA zone names only: `+05:30`, `UTC+4` or `GMT+1` are offsets, not zones (docs/conventions/time.md). */
const ianaZone = Joi.string().custom((value: string) => {
  if (/^(utc|gmt)?\s*[+-]\d/i.test(value) || !isIanaZone(value)) {
    throw new Error('must be an IANA time zone name such as Europe/London (not an offset)');
  }
  return value;
});

function isIanaZone(value: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

/** Placeholder secrets from `.env.example` must never reach production. */
const realSecret = (name: string) =>
  Joi.string()
    .min(32)
    .required()
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string()
        .pattern(/change-me/i, { invert: true })
        .messages({
          'string.pattern.invert.base': `"${name}" is still the local placeholder: generate one with openssl rand -base64 48`,
        }),
    });

/**
 * Every environment variable the app reads, with its default. Boot fails fast with every problem
 * listed at once when something required is missing or malformed. Optional integrations default to
 * empty: an unconfigured integration is absent (its calls fail with INTEGRATION_NOT_CONFIGURED),
 * never a boot failure. `.env.example` documents the same variables, grouped the same way.
 */
export const envValidationSchema = Joi.object({
  // ── App ──
  NODE_ENV: Joi.string().valid('development', 'test', 'staging', 'production').default('development'),
  APP_NAME: Joi.string().default('nestjs-keel'),
  RELEASE: optionalString,
  API_PORT: Joi.number().port().default(3000),
  SOCKET_PORT: Joi.number().port().default(3001),
  GRAPHQL_PORT: Joi.number().port().default(3002),
  GRPC_PORT: Joi.number().port().default(50051),
  // Address the listeners bind to: 0.0.0.0 in containers, 127.0.0.1 behind a reverse proxy on a VPS.
  LISTEN_HOST: Joi.string().ip({ cidr: 'forbidden' }).default('0.0.0.0'),
  API_PREFIX: Joi.string().default('api'),
  API_DEFAULT_VERSION: Joi.string().pattern(/^\d+$/).default('1'),
  TRUST_PROXY: Joi.string().default('1'),
  CORS_ORIGINS: optionalString,
  BODY_LIMIT: Joi.string().default('1mb'),
  SWAGGER_ENABLED: Joi.boolean().default(false),
  /** Base URL of the web app, used in links sent by e-mail (password reset, verification). */
  APP_WEB_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:5173'),

  // ── Time ──
  BUSINESS_TIMEZONE: ianaZone.default('UTC'),
  WEEK_STARTS_ON: Joi.string().valid('monday', 'sunday').default('monday'),

  // ── Logging ──
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent').default('info'),
  LOG_PRETTY: Joi.boolean().default(false),

  // ── MongoDB ──
  MONGO_URI: Joi.string()
    .uri({ scheme: ['mongodb', 'mongodb+srv'] })
    .required(),
  MONGO_AUTO_INDEX: Joi.boolean().default(false),
  MONGO_MAX_POOL_SIZE: Joi.number().integer().min(1).default(50),

  // ── Redis ──
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),
  REDIS_CACHE_URL: optionalUri(['redis', 'rediss']),
  REDIS_KEY_PREFIX: Joi.string().default('app:'),
  CACHE_DEFAULT_TTL_SECONDS: Joi.number().integer().min(1).default(300),

  // ── Auth: tokens, sessions, API keys ──
  JWT_ACCESS_SECRET: realSecret('JWT_ACCESS_SECRET'),
  JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: realSecret('JWT_REFRESH_SECRET')
    .invalid(Joi.ref('JWT_ACCESS_SECRET'))
    .messages({ 'any.invalid': '"JWT_REFRESH_SECRET" must differ from "JWT_ACCESS_SECRET"' }),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('30d'),
  JWT_ISSUER: Joi.string().default('nestjs-keel'),
  JWT_AUDIENCE: Joi.string().default('nestjs-keel'),
  JWT_CLOCK_TOLERANCE_SECONDS: Joi.number().integer().min(0).max(300).default(5),
  AUTH_MAX_SESSIONS_PER_USER: Joi.number().integer().min(1).max(100).default(10),
  AUTH_MAX_FAILED_LOGINS: Joi.number().integer().min(1).max(100).default(5),
  AUTH_LOCKOUT_SECONDS: Joi.number().integer().min(60).max(86_400).default(900),
  USER_DELETION_GRACE_DAYS: Joi.number().integer().min(0).max(365).default(30),
  API_KEYS: Joi.string().pattern(API_KEYS_PATTERN).allow('').default(''),

  // ── OTP ──
  OTP_LENGTH: Joi.number().integer().min(4).max(10).default(6),
  OTP_TTL_SECONDS: Joi.number().integer().min(60).max(3600).default(300),
  OTP_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: Joi.number().integer().min(0).max(600).default(60),
  OTP_MAX_SENDS_PER_HOUR: Joi.number().integer().min(1).max(100).default(5),
  OTP_MAX_VERIFIES_PER_HOUR: Joi.number().integer().min(1).max(200).default(15),
  // Logs codes instead of sending them, so local sign-in works without a phone. Never in production.
  OTP_DEV_LOG: Joi.boolean()
    .default(false)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.valid(false).messages({ 'any.only': '"OTP_DEV_LOG" must be false in production' }),
    }),

  // ── Rate limiting ──
  THROTTLE_TTL_SECONDS: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(120),
  THROTTLE_AUTH_LIMIT: Joi.number().integer().min(1).default(10),
  THROTTLE_OTP_LIMIT: Joi.number().integer().min(1).default(5),
  IDEMPOTENCY_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(7 * 86_400)
    .default(86_400),

  // ── Socket.IO ──
  SOCKET_PATH: Joi.string().default('/socket.io'),
  SOCKET_PING_INTERVAL_MS: Joi.number().integer().default(25_000),
  SOCKET_PING_TIMEOUT_MS: Joi.number().integer().default(20_000),
  SOCKET_MAX_BUFFER_BYTES: Joi.number().integer().default(100_000),
  SOCKET_COMPRESSION_THRESHOLD_BYTES: Joi.number().integer().default(1024),
  SOCKET_EVENTS_PER_WINDOW: Joi.number().integer().min(1).default(30),
  SOCKET_EVENT_WINDOW_MS: Joi.number().integer().min(100).default(10_000),

  // ── GraphQL ──
  GRAPHQL_PATH: Joi.string().default('/graphql'),
  // Defaults to on outside production; set explicitly to override.
  GRAPHQL_INTROSPECTION: Joi.boolean().allow(''),
  GRAPHQL_MAX_DEPTH: Joi.number().integer().min(1).max(50).default(8),
  GRAPHQL_MAX_COMPLEXITY: Joi.number().integer().min(10).max(100_000).default(1000),

  // ── Observability ──
  SENTRY_DSN: optionalString,
  SENTRY_TRACES_SAMPLE_RATE: Joi.number().min(0).max(1).default(0),
  OTEL_ENABLED: Joi.boolean().default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUri(['http', 'https']),
  OTEL_SERVICE_NAME: optionalString,

  // ── Audit ──
  AUDIT_RETENTION_DAYS: Joi.number().integer().min(1).max(3650).default(90),

  // ── S3 (empty bucket = file storage not configured) ──
  AWS_REGION: Joi.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
  S3_BUCKET: optionalString,
  // MinIO / LocalStack / R2: set the endpoint and usually path-style addressing.
  S3_ENDPOINT: optionalUri(['http', 'https']),
  S3_FORCE_PATH_STYLE: Joi.boolean().default(false),
  S3_PUBLIC_BASE_URL: optionalUri(['http', 'https']),
  S3_PRESIGN_EXPIRES_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(7 * 86_400)
    .default(900),
  S3_MAX_UPLOAD_BYTES: Joi.number()
    .integer()
    .min(1024)
    .default(10 * 1024 * 1024),

  // ── Mail (empty host = e-mail not configured) ──
  SMTP_HOST: optionalString,
  SMTP_PORT: Joi.number().port().default(587),
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  MAIL_FROM: Joi.string().default('No Reply <no-reply@example.com>'),

  // ── SMS: Twilio (empty SID = SMS not configured) ──
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  // A phone number in E.164 or a Messaging Service SID (MG…).
  TWILIO_FROM: optionalString,

  // ── Push: Firebase Admin (both empty = push not configured) ──
  // Service-account JSON, raw or base64. Never commit the key file.
  FIREBASE_CREDENTIALS_JSON: optionalString,
  FIREBASE_CREDENTIALS_FILE: optionalString,

  // ── Web Push: VAPID (empty keys = browser push not configured) ──
  // `pnpm webpush:keys` prints a pair. Base64url, as the browser's applicationServerKey expects.
  WEB_PUSH_VAPID_PUBLIC_KEY: Joi.string()
    .pattern(/^[A-Za-z0-9_-]{87}$/)
    .allow('')
    .default('')
    .messages({
      'string.pattern.base': '"WEB_PUSH_VAPID_PUBLIC_KEY" must be a base64url VAPID public key (87 characters)',
    }),
  WEB_PUSH_VAPID_PRIVATE_KEY: Joi.string()
    .pattern(/^[A-Za-z0-9_-]{43}$/)
    .allow('')
    .default('')
    .messages({
      'string.pattern.base': '"WEB_PUSH_VAPID_PRIVATE_KEY" must be a base64url VAPID private key (43 characters)',
    }),
  // Contact push services use when something goes wrong: a mailto: address or an https: URL.
  WEB_PUSH_SUBJECT: Joi.string()
    .pattern(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/)
    .default('mailto:no-reply@example.com'),
  // How long a push service keeps a message for an offline browser.
  WEB_PUSH_TTL_SECONDS: Joi.number().integer().min(0).max(2_419_200).default(86_400),
  // Push services the API will deliver to (host or parent domain). Subscriptions elsewhere are refused:
  // the server POSTs to the subscription URL, so an open list would let anyone aim it at any host.
  WEB_PUSH_ALLOWED_HOSTS: Joi.string()
    .pattern(/^\s*[a-z0-9.-]+\s*(,\s*[a-z0-9.-]+\s*)*$/i)
    .default('fcm.googleapis.com,push.services.mozilla.com,push.apple.com,notify.windows.com'),

  // ── Payments: Stripe (empty key = payments not configured) ──
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  STRIPE_SUCCESS_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:5173/billing/success'),
  STRIPE_CANCEL_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:5173/billing/cancel'),
  STRIPE_PORTAL_RETURN_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:5173/billing'),

  // ── Notifications ──
  NOTIFICATIONS_INBOX_RETENTION_DAYS: Joi.number().integer().min(1).max(365).default(90),

  // ── Events and inter-service transport ──
  OUTBOX_POLL_INTERVAL_MS: ms(100, 60_000, 1000),
  OUTBOX_BATCH_SIZE: Joi.number().integer().min(1).max(1000).default(100),
  // Where domain events go besides in-process handlers: none, or the RabbitMQ topic exchange.
  EVENTS_EXTERNAL: Joi.string().valid('none', 'rabbitmq').default('none'),
  // `module=driver` pairs: which ports are called over the wire (default: in-process).
  TRANSPORT_ROUTES: Joi.string()
    .pattern(/^\s*([a-z][a-z0-9-]*\s*=\s*(inprocess|grpc|rabbitmq)\s*(,\s*|$))*$/)
    .allow('')
    .default(''),
  RABBITMQ_URL: optionalUri(['amqp', 'amqps']),
  RABBITMQ_EXCHANGE: Joi.string().default('app.events'),
  RABBITMQ_PREFETCH: Joi.number().integer().min(1).max(1000).default(20),
  GRPC_EXAMPLES_URL: Joi.string().default('localhost:50051'),
  GRPC_DEADLINE_MS: ms(100, 60_000, 3000),

  // ── Resilience: outbound integrations ──
  INTEGRATION_BREAKER_ENABLED: Joi.boolean().default(true),
  INTEGRATION_BREAKER_FAILURE_THRESHOLD: Joi.number().integer().min(1).max(1000).default(5),
  INTEGRATION_BREAKER_OPEN_SECONDS: Joi.number().integer().min(1).max(3600).default(30),
  // `name=threshold/openSeconds` per integration (s3, smtp, twilio, fcm, webpush, stripe), e.g. fcm=10/60.
  INTEGRATION_BREAKER_OVERRIDES: Joi.string()
    .pattern(/^\s*[a-z0-9-]+\s*=\s*\d+\s*\/\s*\d+\s*(,\s*[a-z0-9-]+\s*=\s*\d+\s*\/\s*\d+\s*)*$/i)
    .allow('')
    .default(''),
  INTEGRATION_HTTP_TIMEOUT_MS: ms(500, 120_000, 10_000),
  FCM_TIMEOUT_MS: ms(1000, 300_000, 30_000),
  WEB_PUSH_TIMEOUT_MS: ms(1000, 120_000, 10_000),
  SMTP_TIMEOUT_MS: ms(1000, 300_000, 20_000),
  S3_TIMEOUT_MS: ms(1000, 300_000, 30_000),
  TWILIO_TIMEOUT_MS: ms(1000, 120_000, 15_000),
  STRIPE_TIMEOUT_MS: ms(1000, 120_000, 20_000),

  // ── Runtime fault tolerance: shutdown, HTTP, MongoDB, Redis ──
  SHUTDOWN_TIMEOUT_MS: ms(1000, 300_000, 25_000),
  SHUTDOWN_DRAIN_DELAY_MS: ms(0, 60_000, 0),
  REQUEST_TIMEOUT_MS: ms(1000, 600_000, 30_000),
  REQUEST_TIMEOUT_UPLOAD_MS: ms(1000, 600_000, 120_000),
  HTTP_KEEP_ALIVE_TIMEOUT_MS: ms(1000, 600_000, 65_000),
  MONGO_SERVER_SELECTION_TIMEOUT_MS: ms(200, 60_000, 5000),
  MONGO_CONNECT_TIMEOUT_MS: ms(200, 60_000, 10_000),
  MONGO_WAIT_QUEUE_TIMEOUT_MS: ms(100, 60_000, 5000),
  MONGO_TRANSACTION_MAX_ATTEMPTS: Joi.number().integer().min(1).max(50).default(20),
  MONGO_TRANSACTION_RETRY_WINDOW_MS: ms(0, 120_000, 10_000),
  REDIS_CONNECT_TIMEOUT_MS: ms(200, 60_000, 5000),
  REDIS_COMMAND_TIMEOUT_MS: ms(100, 60_000, 3000),
  REDIS_MAX_RETRIES_PER_REQUEST: Joi.number().integer().min(0).max(20).default(2),
  REDIS_CACHE_COMMAND_TIMEOUT_MS: ms(50, 10_000, 500),
}).custom((env: Record<string, unknown>) => {
  // One VAPID key without the other is a half-pasted pair, not "browser push off".
  if (Boolean(env.WEB_PUSH_VAPID_PUBLIC_KEY) !== Boolean(env.WEB_PUSH_VAPID_PRIVATE_KEY)) {
    throw new Error('"WEB_PUSH_VAPID_PUBLIC_KEY" and "WEB_PUSH_VAPID_PRIVATE_KEY" are set together');
  }
  return env;
});
