import { parseArgs } from 'node:util';
import { assertLocalMongoUri } from '@/common/safety/local-only';

export interface SeedOptions {
  /** People to create (a few deactivated and deletion-pending ones included). */
  users: number;
  /** RNG seed: the same seed (on the same day) produces the same data. */
  seed: number;
  /** Drop the target database first. */
  reset: boolean;
  /** Allow a database whose name does not look disposable. */
  force: boolean;
  /** Replace the database name of MONGO_URI. */
  db?: string;
}

export const SEED_USAGE = `Usage: pnpm seed [--users 50] [--seed 1] [--reset] [--db <name>] [--force]

  --users <n>   people to create (5..5000, default 50)
  --seed <n>    RNG seed; the same seed and day give the same data (default 1)
  --reset       drop the target database first (only that database)
  --db <name>   use this database name instead of the one in MONGO_URI
  --force       allow a database whose name contains none of: dev, local, seed, app

Targets MONGO_URI / REDIS_URL from the environment or .env (the docker compose infra by default).
Refuses NODE_ENV=production and any database that is not on this machine. Never asks for input.`;

export const MIN_USERS = 5;
export const MAX_USERS = 5000;

/** A refusal with a message for the console (exit code 1, nothing written). */
export class SeedRefusal extends Error {}

export function parseSeedArgs(argv: readonly string[]): SeedOptions {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        users: { type: 'string' },
        seed: { type: 'string' },
        reset: { type: 'boolean' },
        force: { type: 'boolean' },
        db: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    throw new SeedRefusal(`${error instanceof Error ? error.message : String(error)}\n\n${SEED_USAGE}`);
  }
  if (values.help) throw new SeedRefusal(SEED_USAGE);
  const users = integer(values.users, 'users', 50);
  if (users < MIN_USERS || users > MAX_USERS) {
    throw new SeedRefusal(`--users must be between ${MIN_USERS} and ${MAX_USERS}`);
  }
  const db = typeof values.db === 'string' ? values.db.trim() : undefined;
  if (db !== undefined && !/^[A-Za-z0-9_-]{1,63}$/.test(db)) {
    throw new SeedRefusal('--db must be 1-63 letters, digits, dashes or underscores');
  }
  return {
    users,
    seed: integer(values.seed, 'seed', 1),
    reset: values.reset === true,
    force: values.force === true,
    db,
  };
}

function integer(raw: string | boolean | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) throw new SeedRefusal(`--${name} must be a whole number`);
  return Number(raw);
}

export interface SeedTarget {
  uri: string;
  dbName: string;
  /** Hosts and database, credentials hidden: safe to print. */
  display: string;
}

const MONGO_URI_PATTERN = /^(mongodb(?:\+srv)?:\/\/)(?:([^@/]*)@)?([^/?]*)(?:\/([^?]*))?(\?.*)?$/;
const DISPOSABLE_DB_NAME = /dev|local|seed|^app$/i;

/**
 * The safety gates, before anything connects: never production, only a database on this machine
 * (`mongodb+srv` always counts as remote), and only a database whose name says it is disposable
 * unless `--force` is given.
 */
export function resolveTarget(env: { NODE_ENV?: string; MONGO_URI?: string }, options: SeedOptions): SeedTarget {
  if (env.NODE_ENV === 'production') throw new SeedRefusal('Refusing to seed: NODE_ENV is production.');
  try {
    assertLocalMongoUri(env.MONGO_URI ?? '', 'pnpm seed', '--force');
  } catch (err) {
    throw new SeedRefusal(err instanceof Error ? err.message : String(err));
  }
  const match = MONGO_URI_PATTERN.exec(env.MONGO_URI ?? '');
  if (!match) throw new SeedRefusal('Refusing to seed: MONGO_URI is not a mongodb:// URI.');
  const [, scheme, credentials, hosts, path = '', query = ''] = match;
  const dbName = options.db ?? (decodeURIComponent(path) || 'test');
  if (!options.force && !DISPOSABLE_DB_NAME.test(dbName)) {
    throw new SeedRefusal(
      `Refusing to seed database "${dbName}": its name does not look disposable (dev, local, seed).\n` +
        'Use --db <name> (for example --db app_dev) or pass --force if this database really is disposable.',
    );
  }
  const auth = credentials !== undefined ? `${credentials}@` : '';
  return {
    uri: `${scheme}${auth}${hosts}/${encodeURIComponent(dbName)}${query}`,
    dbName,
    display: `${scheme}${credentials !== undefined ? '***@' : ''}${hosts}/${dbName}`,
  };
}
