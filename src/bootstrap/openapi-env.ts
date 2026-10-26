/*
 * Imported before the api module by `createOpenApiDocument` callers (the export CLI and the
 * contract test). The config schema requires these at import time; building the document never
 * connects anywhere, so unreachable placeholders are enough. Real values, when set, win.
 */
const placeholders: Record<string, string> = {
  MONGO_URI: 'mongodb://openapi.invalid:27017/openapi',
  REDIS_URL: 'redis://openapi.invalid:6379',
  REDIS_CACHE_URL: 'redis://openapi.invalid:6380',
  JWT_ACCESS_SECRET: 'openapi-placeholder-not-a-secret-0000000000',
  JWT_REFRESH_SECRET: 'openapi-placeholder-not-a-secret-1111111111',
};

for (const [key, value] of Object.entries(placeholders)) process.env[key] ||= value;
