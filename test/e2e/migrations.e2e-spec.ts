import mongoose, { type Connection } from 'mongoose';
import { timeZone } from '@/common/time/zoned-time';
import { MigrationRunner } from '@/migrations/migration.runner';
import type { Migration } from '@/migrations/migration.types';
import backfill from '@/migrations/scripts/20261026000000-notes-backfill-created-day';

const silent = { log: () => undefined, warn: () => undefined };

/** The runner (history, lock, dry run, down) and the example migration, on a real database. */
describe('Migrations (e2e)', () => {
  let connection: Connection;
  const migrations: Migration[] = [{ ...backfill, name: '20261026000000-notes-backfill-created-day' }];
  const runner = () => new MigrationRunner(connection, migrations, silent, timeZone('Asia/Dubai'));

  beforeAll(async () => {
    connection = await mongoose.createConnection(process.env.MONGO_URI!).asPromise();
    await connection.dropDatabase();
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
  });

  it('dry-runs, applies once, records history, and reverts exactly what it changed', async () => {
    const notes = connection.collection('notes');
    await notes.insertMany([
      { title: 'old', createdAt: new Date('2026-10-12T21:00:00Z') },
      { title: 'new', createdAt: new Date('2026-10-12T10:00:00Z'), createdDay: '2026-10-12' },
    ]);

    await runner().up({ dryRun: true });
    expect(await notes.countDocuments({ createdDay: { $exists: true } })).toBe(1);
    expect((await runner().status())[0].appliedAt).toBeUndefined();

    await expect(runner().up()).resolves.toEqual(['20261026000000-notes-backfill-created-day']);
    // 21:00 UTC on the 12th is 01:00 on the 13th in Dubai: the business day, not the UTC one.
    expect(await notes.findOne({ title: 'old' })).toMatchObject({ createdDay: '2026-10-13' });
    await expect(runner().up()).resolves.toEqual([]);

    await runner().down();
    expect(await notes.findOne({ title: 'old' })).not.toHaveProperty('createdDay');
    expect(await notes.findOne({ title: 'new' })).toMatchObject({ createdDay: '2026-10-12' });
  });

  it('refuses to run while another runner holds the lock', async () => {
    await connection
      .collection('_migrations_lock')
      .insertOne({ _id: 'lock' as never, lockedAt: new Date(), host: 'elsewhere' });
    await expect(runner().up()).rejects.toThrow(/holds the lock/);
    await runner().unlock();
    await expect(runner().up()).resolves.toHaveLength(1);
  });
});
