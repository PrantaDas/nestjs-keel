import '@/common/time/force-utc';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { systemClock } from '@/common/time/clock';
import { loadMigrations } from '@/migrations/migration.loader';
import { MigrationRunner } from '@/migrations/migration.runner';
import { scheduleBusinessTimeZone } from '@/config/schedule-zone';
import { requireEnv } from './load-env';

const USAGE = `
Usage: pnpm migrate <command> [options]

  status                     List migrations and whether they are applied
  up [--dry-run] [--to N]    Apply pending migrations (optionally up to N)
  down [--steps n] [--dry-run]  Revert the last n applied migrations (default 1)
  create <name>              Scaffold src/migrations/scripts/<timestamp>-<name>.ts
  unlock                     Release a lock left by a crashed run
`;

const TEMPLATE = (description: string) => `import { forEachBatch } from '../migration.utils';
import { MigrationDefinition } from '../migration.types';

const migration: MigrationDefinition = {
  description: '${description}',

  async up({ db, dryRun, logger }) {
    const collection = db.collection('CHANGE_ME');
    const filter = {}; // must exclude already-migrated documents (idempotency)

    if (dryRun) {
      logger.log('Would migrate documents', { count: await collection.countDocuments(filter) });
      return;
    }
    const migrated = await forEachBatch(collection, filter, 1000, async (docs) => {
      await collection.bulkWrite(docs.map((doc) => ({ updateOne: { filter: { _id: doc._id }, update: { $set: {} } } })));
    });
    logger.log('Migrated documents', { migrated });
  },

  async down({ db, dryRun, logger }) {
    // Undo exactly what up() did (mark migrated documents if the change is not otherwise visible).
    throw new Error('down not implemented');
  },
};

export default migration;
`;

const logger = {
  log: (message: string, meta?: Record<string, unknown>) => console.log(message, meta ? JSON.stringify(meta) : ''),
  warn: (message: string, meta?: Record<string, unknown>) => console.warn(message, meta ? JSON.stringify(meta) : ''),
};

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' }, to: { type: 'string' }, steps: { type: 'string' } },
  });
  const [command, arg] = positionals;

  if (command === 'create') return create(arg);
  if (!['status', 'up', 'down', 'unlock'].includes(command ?? '')) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const connection = await mongoose
    .createConnection(requireEnv('MONGO_URI'), { serverSelectionTimeoutMS: 10_000 })
    .asPromise();
  const runner = new MigrationRunner(connection, loadMigrations(), logger, scheduleBusinessTimeZone());

  try {
    if (command === 'status') {
      console.table((await runner.status()).map((s) => ({ ...s, appliedAt: s.appliedAt?.toISOString() ?? 'PENDING' })));
    } else if (command === 'up') {
      await runner.up({ dryRun: values['dry-run'], to: values.to });
    } else if (command === 'down') {
      await runner.down({ steps: values.steps ? Number(values.steps) : 1, dryRun: values['dry-run'] });
    } else {
      await runner.unlock();
      logger.log('Lock released');
    }
  } finally {
    await connection.close();
  }
}

function create(name?: string): void {
  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    console.error('Name must be kebab-case, e.g. `pnpm migrate create backfill-user-wallets`');
    process.exit(1);
  }
  const stamp = systemClock.now().toISOString().replace(/\D/g, '').slice(0, 14);
  const dir = join(process.cwd(), 'src/migrations/scripts');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stamp}-${name}.ts`);
  writeFileSync(file, TEMPLATE(name.replace(/-/g, ' ')));
  console.log(`Created ${file}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
