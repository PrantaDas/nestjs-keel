import '@/config/load-env';

/** CLI helpers: `.env` is loaded by the import above, the same way the processes load it. */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Missing required environment variable ${key}`);
    process.exit(1);
  }
  return value;
}
