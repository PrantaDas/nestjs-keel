import '@/common/time/force-utc';
import '@/config/load-env';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { MovableClock } from '@/common/time/clock';
import { useProcessClock } from '@/common/time/time.module';
import { CliModule } from './cli.module';
import { parseSeedArgs, resolveTarget, SeedRefusal } from './seed/options';
import { runSeed } from './seed/run-seed';

/**
 * `pnpm seed`: a realistic local dataset in one command (see `--help`). Every gate runs before
 * anything connects; the target is printed without credentials; it never asks for input.
 */
async function main(): Promise<void> {
  const options = parseSeedArgs(process.argv.slice(2));
  const target = resolveTarget(process.env, options);
  process.env.MONGO_URI = target.uri;
  console.log(`Seeding ${target.display} (seed ${options.seed}, ${options.users} people)`);

  const clock = new MovableClock();
  useProcessClock(clock);
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
  try {
    const connection = app.get<Connection>(getConnectionToken());
    if (options.reset) {
      await connection.dropDatabase();
    } else {
      const collections = await connection.db!.listCollections({}, { nameOnly: true }).toArray();
      const used = await Promise.all(
        collections.map((c) => connection.db!.collection(c.name).estimatedDocumentCount()),
      );
      if (used.some((count) => count > 0)) {
        throw new SeedRefusal(
          `Refusing to seed: ${target.dbName} already has data. Re-run with --reset to replace it.`,
        );
      }
    }
    await connection.syncIndexes();
    const started = performance.now();
    const summary = await runSeed(app, clock, options);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);

    console.log(`\nDone in ${seconds} s.`);
    console.log(
      `  People: ${summary.users} (${summary.deactivated} deactivated, ${summary.deletionPending} pending deletion)`,
    );
    console.log(`  Notes: ${summary.notes} (${summary.deletedNotes} in the bin, ${summary.reminders} with a reminder)`);
    console.log('\nSign in (these passwords are shown once and stored only as hashes):');
    for (const staff of summary.staff) {
      console.log(`  ${staff.role.padEnd(11)} ${staff.email}  ${summary.passwords.staff}`);
    }
    console.log(
      `  user        ${summary.sampleUser}  ${summary.passwords.users}   (every seeded person has this password)`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof SeedRefusal ? err.message : err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
