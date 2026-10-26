import { type ConfigFactory, registerAs } from '@nestjs/config';

/*
 * Typed config namespaces. The only place that reads `process.env` (ESLint enforces it): everything
 * else injects a namespace, e.g. `@Inject(authConfig.KEY) config: ConfigType<typeof authConfig>`.
 * Values are already validated and defaulted by `envValidationSchema` when these factories run.
 */

const env = (key: string): string => process.env[key] ?? '';
const num = (key: string): number => Number(process.env[key]);
const bool = (key: string): boolean => process.env[key] === 'true';
const list = (key: string): string[] =>
  env(key)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

/** `a=1,b=2` → { a: '1', b: '2' } (format validated by the env schema). */
const pairs = (key: string): Record<string, string> =>
  Object.fromEntries(
    list(key)
      .map((pair) => pair.split('=').map((part) => part.trim()) as [string, string])
      .filter(([name, value]) => Boolean(name) && Boolean(value)),
  );

/** Express `trust proxy` accepts a hop count, a boolean or a subnet list. */
const parseTrustProxy = (value: string): number | boolean | string => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return /^\d+$/.test(value) ? Number(value) : value;
};

export const appConfig = registerAs('app', () => ({
  env: env('NODE_ENV'),
  isProduction: env('NODE_ENV') === 'production',
  name: env('APP_NAME'),
  release: env('RELEASE') || undefined,
  apiPort: num('API_PORT'),
  socketPort: num('SOCKET_PORT'),
  graphqlPort: num('GRAPHQL_PORT'),
  grpcPort: num('GRPC_PORT'),
  apiPrefix: env('API_PREFIX'),
  defaultVersion: env('API_DEFAULT_VERSION'),
  trustProxy: parseTrustProxy(env('TRUST_PROXY')),
  corsOrigins: list('CORS_ORIGINS'),
  bodyLimit: env('BODY_LIMIT'),
  swaggerEnabled: bool('SWAGGER_ENABLED'),
  webUrl: env('APP_WEB_URL'),
}));

export const timeConfig = registerAs('time', () => ({
  /** The zone business days (`DayKey`), weeks and months are computed in. */
  businessTimeZone: env('BUSINESS_TIMEZONE'),
  weekStartsOn: env('WEEK_STARTS_ON') as 'monday' | 'sunday',
}));

export const loggerConfig = registerAs('logger', () => ({
  level: env('LOG_LEVEL'),
  pretty: bool('LOG_PRETTY'),
}));

export const mongoConfig = registerAs('mongo', () => ({
  uri: env('MONGO_URI'),
  autoIndex: bool('MONGO_AUTO_INDEX'),
  maxPoolSize: num('MONGO_MAX_POOL_SIZE'),
}));

export const redisConfig = registerAs('redis', () => ({
  url: env('REDIS_URL'),
  /** Empty: no cache Redis, every cache read is a miss (the app works, only slower). */
  cacheUrl: env('REDIS_CACHE_URL'),
  keyPrefix: env('REDIS_KEY_PREFIX'),
  cacheDefaultTtlSeconds: num('CACHE_DEFAULT_TTL_SECONDS'),
}));

export const authConfig = registerAs('auth', () => ({
  accessSecret: env('JWT_ACCESS_SECRET'),
  accessExpiresIn: env('JWT_ACCESS_EXPIRES_IN'),
  refreshSecret: env('JWT_REFRESH_SECRET'),
  refreshExpiresIn: env('JWT_REFRESH_EXPIRES_IN'),
  issuer: env('JWT_ISSUER'),
  audience: env('JWT_AUDIENCE'),
  clockToleranceSeconds: num('JWT_CLOCK_TOLERANCE_SECONDS'),
  maxSessionsPerUser: num('AUTH_MAX_SESSIONS_PER_USER'),
  maxFailedLogins: num('AUTH_MAX_FAILED_LOGINS'),
  lockoutSeconds: num('AUTH_LOCKOUT_SECONDS'),
  deletionGraceDays: num('USER_DELETION_GRACE_DAYS'),
  /** Machine clients: key name → SHA-256 (hex) of the key. The plain key is never stored. */
  apiKeys: pairs('API_KEYS'),
}));

export const otpConfig = registerAs('otp', () => ({
  length: num('OTP_LENGTH'),
  ttlSeconds: num('OTP_TTL_SECONDS'),
  maxAttempts: num('OTP_MAX_ATTEMPTS'),
  resendCooldownSeconds: num('OTP_RESEND_COOLDOWN_SECONDS'),
  maxSendsPerHour: num('OTP_MAX_SENDS_PER_HOUR'),
  maxVerifiesPerHour: num('OTP_MAX_VERIFIES_PER_HOUR'),
  /** Codes are logged instead of sent (refused in production by the env schema). */
  devLog: bool('OTP_DEV_LOG') && env('NODE_ENV') !== 'production',
}));

export const throttleConfig = registerAs('throttle', () => ({
  ttlMs: num('THROTTLE_TTL_SECONDS') * 1000,
  limit: num('THROTTLE_LIMIT'),
  authLimit: num('THROTTLE_AUTH_LIMIT'),
  otpLimit: num('THROTTLE_OTP_LIMIT'),
  idempotencyTtlSeconds: num('IDEMPOTENCY_TTL_SECONDS'),
}));

export const socketConfig = registerAs('socket', () => ({
  path: env('SOCKET_PATH'),
  pingIntervalMs: num('SOCKET_PING_INTERVAL_MS'),
  pingTimeoutMs: num('SOCKET_PING_TIMEOUT_MS'),
  maxBufferBytes: num('SOCKET_MAX_BUFFER_BYTES'),
  compressionThresholdBytes: num('SOCKET_COMPRESSION_THRESHOLD_BYTES'),
  eventsPerWindow: num('SOCKET_EVENTS_PER_WINDOW'),
  eventWindowMs: num('SOCKET_EVENT_WINDOW_MS'),
}));

export const graphqlConfig = registerAs('graphql', () => ({
  path: env('GRAPHQL_PATH'),
  introspection: process.env.GRAPHQL_INTROSPECTION ? bool('GRAPHQL_INTROSPECTION') : env('NODE_ENV') !== 'production',
  maxDepth: num('GRAPHQL_MAX_DEPTH'),
  maxComplexity: num('GRAPHQL_MAX_COMPLEXITY'),
}));

export const auditConfig = registerAs('audit', () => ({
  retentionDays: num('AUDIT_RETENTION_DAYS'),
}));

export const storageConfig = registerAs('storage', () => ({
  region: env('AWS_REGION'),
  accessKeyId: env('AWS_ACCESS_KEY_ID'),
  secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
  bucket: env('S3_BUCKET'),
  endpoint: env('S3_ENDPOINT') || undefined,
  forcePathStyle: bool('S3_FORCE_PATH_STYLE'),
  publicBaseUrl: env('S3_PUBLIC_BASE_URL'),
  presignExpiresSeconds: num('S3_PRESIGN_EXPIRES_SECONDS'),
  maxUploadBytes: num('S3_MAX_UPLOAD_BYTES'),
}));

export const integrationsConfig = registerAs('integrations', () => ({
  smtp: {
    host: env('SMTP_HOST'),
    port: num('SMTP_PORT'),
    secure: bool('SMTP_SECURE'),
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('MAIL_FROM'),
  },
  twilio: {
    accountSid: env('TWILIO_ACCOUNT_SID'),
    authToken: env('TWILIO_AUTH_TOKEN'),
    from: env('TWILIO_FROM'),
  },
  firebase: {
    credentialsJson: env('FIREBASE_CREDENTIALS_JSON'),
    credentialsFile: env('FIREBASE_CREDENTIALS_FILE'),
  },
}));

export const stripeConfig = registerAs('stripe', () => ({
  secretKey: env('STRIPE_SECRET_KEY'),
  webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  successUrl: env('STRIPE_SUCCESS_URL'),
  cancelUrl: env('STRIPE_CANCEL_URL'),
  portalReturnUrl: env('STRIPE_PORTAL_RETURN_URL'),
}));

export const notificationsConfig = registerAs('notifications', () => ({
  inboxRetentionDays: num('NOTIFICATIONS_INBOX_RETENTION_DAYS'),
}));

export const observabilityConfig = registerAs('observability', () => ({
  sentryDsn: env('SENTRY_DSN'),
  otelEnabled: bool('OTEL_ENABLED'),
}));

export type TransportDriver = 'inprocess' | 'grpc' | 'rabbitmq';

export const transportConfig = registerAs('transport', () => ({
  outbox: {
    pollIntervalMs: num('OUTBOX_POLL_INTERVAL_MS'),
    batchSize: num('OUTBOX_BATCH_SIZE'),
  },
  eventsExternal: env('EVENTS_EXTERNAL') as 'none' | 'rabbitmq',
  /** Port name → driver; anything not listed runs in-process. */
  routes: pairs('TRANSPORT_ROUTES') as Record<string, TransportDriver>,
  rabbitmq: {
    url: env('RABBITMQ_URL'),
    exchange: env('RABBITMQ_EXCHANGE'),
    prefetch: num('RABBITMQ_PREFETCH'),
  },
  grpc: {
    examplesUrl: env('GRPC_EXAMPLES_URL'),
    deadlineMs: num('GRPC_DEADLINE_MS'),
  },
}));

export const resilienceConfig = registerAs('resilience', () => ({
  breaker: {
    enabled: env('INTEGRATION_BREAKER_ENABLED') !== 'false',
    /** Consecutive transient failures that open an integration's circuit (per process). */
    failureThreshold: num('INTEGRATION_BREAKER_FAILURE_THRESHOLD'),
    /** How long an open circuit fails fast before one probe call is let through. */
    openMs: num('INTEGRATION_BREAKER_OPEN_SECONDS') * 1000,
    /** `fcm=10/60,smtp=3/120`: per-integration failure threshold / open seconds. */
    overrides: env('INTEGRATION_BREAKER_OVERRIDES'),
  },
  timeouts: {
    http: num('INTEGRATION_HTTP_TIMEOUT_MS'),
    fcm: num('FCM_TIMEOUT_MS'),
    smtp: num('SMTP_TIMEOUT_MS'),
    s3: num('S3_TIMEOUT_MS'),
    twilio: num('TWILIO_TIMEOUT_MS'),
    stripe: num('STRIPE_TIMEOUT_MS'),
  },
}));

/** Runtime fault tolerance (docs/architecture/fault-tolerance.md): shutdown, HTTP, MongoDB, Redis. */
export const runtimeConfig = registerAs('runtime', () => ({
  shutdown: {
    /** Hard deadline for a graceful shutdown; must stay below the platform kill timeout. */
    timeoutMs: num('SHUTDOWN_TIMEOUT_MS'),
    /** Readiness answers 503 this long before the listener closes (load balancer catch-up). */
    drainDelayMs: num('SHUTDOWN_DRAIN_DELAY_MS'),
  },
  http: {
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS'),
    /** Multipart uploads on slow mobile networks. */
    uploadRequestTimeoutMs: num('REQUEST_TIMEOUT_UPLOAD_MS'),
    keepAliveTimeoutMs: num('HTTP_KEEP_ALIVE_TIMEOUT_MS'),
  },
  mongo: {
    /** Also the Mongoose buffer timeout: how long a query waits while the connection is down. */
    serverSelectionTimeoutMs: num('MONGO_SERVER_SELECTION_TIMEOUT_MS'),
    connectTimeoutMs: num('MONGO_CONNECT_TIMEOUT_MS'),
    /** How long a query waits for a pooled connection while all of them are busy (slow database). */
    waitQueueTimeoutMs: num('MONGO_WAIT_QUEUE_TIMEOUT_MS'),
    transactionMaxAttempts: num('MONGO_TRANSACTION_MAX_ATTEMPTS'),
    /** No transaction retry starts once this much time has passed since the first attempt. */
    transactionRetryWindowMs: num('MONGO_TRANSACTION_RETRY_WINDOW_MS'),
  },
  redis: {
    connectTimeoutMs: num('REDIS_CONNECT_TIMEOUT_MS'),
    /** Core Redis: locks, sessions, OTP, rate limits, socket pub/sub. */
    commandTimeoutMs: num('REDIS_COMMAND_TIMEOUT_MS'),
    maxRetriesPerRequest: num('REDIS_MAX_RETRIES_PER_REQUEST'),
    /** Cache Redis: a slower answer counts as a miss. */
    cacheCommandTimeoutMs: num('REDIS_CACHE_COMMAND_TIMEOUT_MS'),
  },
}));

export const allConfigs: ConfigFactory[] = [
  appConfig,
  timeConfig,
  loggerConfig,
  mongoConfig,
  redisConfig,
  authConfig,
  otpConfig,
  throttleConfig,
  socketConfig,
  graphqlConfig,
  auditConfig,
  storageConfig,
  integrationsConfig,
  stripeConfig,
  notificationsConfig,
  observabilityConfig,
  transportConfig,
  resilienceConfig,
  runtimeConfig,
];

/**
 * Which optional integrations are configured, read once at module-definition time (before DI) so
 * process modules can leave unconfigured features out: no Stripe key, no payments webhook worker.
 * Same rules the feature services apply at call time (`IntegrationNotConfiguredException`).
 */
export const features = {
  stripe: (): boolean => Boolean(env('STRIPE_SECRET_KEY')),
  rabbitmq: (): boolean => Boolean(env('RABBITMQ_URL')),
  otel: (): boolean => bool('OTEL_ENABLED'),
  /** Domain events also go to the RabbitMQ topic exchange (`EVENTS_EXTERNAL=rabbitmq`). */
  externalEvents: (): boolean => env('EVENTS_EXTERNAL') === 'rabbitmq',
  /** How a port is reached: in-process unless `TRANSPORT_ROUTES` names a driver for it. */
  transportRoute: (port: string): TransportDriver =>
    (pairs('TRANSPORT_ROUTES')[port] as TransportDriver) || 'inprocess',
};
