import { hostname } from 'node:os';
import { systemClock } from '@/common/time/clock';
import type { TimeZone } from '@/common/time/time.types';
import { timeZone } from '@/common/time/zoned-time';
import type { Connection } from 'mongoose';
import { Migration, MigrationContext, MigrationLogger } from './migration.types';

const HISTORY = '_migrations';
const LOCK = '_migrations_lock';

interface HistoryEntry {
  _id: string;
  appliedAt: Date;
  durationMs: number;
}

export interface MigrationStatus {
  name: string;
  description: string;
  appliedAt?: Date;
}

/**
 * Applies migrations in file-name order and records each one in `_migrations`. A lock document
 * prevents two runners (e.g. two deploys) from migrating at the same time.
 */
export class MigrationRunner {
  constructor(
    private readonly connection: Connection,
    private readonly migrations: Migration[],
    private readonly logger: MigrationLogger,
    private readonly businessTimeZone: TimeZone = timeZone('UTC'),
  ) {}

  async status(): Promise<MigrationStatus[]> {
    const applied = await this.appliedMap();
    return this.migrations.map((m) => ({
      name: m.name,
      description: m.description,
      appliedAt: applied.get(m.name)?.appliedAt,
    }));
  }

  async up(options: { dryRun?: boolean; to?: string } = {}): Promise<string[]> {
    return this.withLock(async () => {
      const applied = await this.appliedMap();
      const pending = this.migrations.filter((m) => !applied.has(m.name));
      const targetIndex = options.to ? pending.findIndex((m) => m.name === options.to) : pending.length - 1;
      if (options.to && targetIndex === -1) throw new Error(`Migration "${options.to}" is not pending`);

      const toRun = pending.slice(0, targetIndex + 1);
      if (toRun.length === 0) this.logger.log('No pending migrations');

      for (const migration of toRun) {
        await this.execute(migration, 'up', Boolean(options.dryRun));
      }
      return toRun.map((m) => m.name);
    });
  }

  async down(options: { steps?: number; dryRun?: boolean } = {}): Promise<string[]> {
    return this.withLock(async () => {
      const applied = await this.appliedMap();
      const toRevert = this.migrations
        .filter((m) => applied.has(m.name))
        .reverse()
        .slice(0, options.steps ?? 1);

      for (const migration of toRevert) {
        await this.execute(migration, 'down', Boolean(options.dryRun));
      }
      return toRevert.map((m) => m.name);
    });
  }

  async unlock(): Promise<void> {
    await this.connection.collection(LOCK).deleteOne({ _id: 'lock' as never });
  }

  private async execute(migration: Migration, direction: 'up' | 'down', dryRun: boolean): Promise<void> {
    const ctx: MigrationContext = {
      db: this.connection.db!,
      connection: this.connection,
      dryRun,
      logger: this.logger,
      businessTimeZone: this.businessTimeZone,
    };
    const label = `${direction.toUpperCase()}${dryRun ? ' (dry run)' : ''} ${migration.name}`;
    const startedAt = performance.now();
    this.logger.log(`▶ ${label}: ${migration.description}`);

    await migration[direction](ctx);
    const durationMs = Math.round(performance.now() - startedAt);

    if (!dryRun) {
      const history = this.connection.collection<HistoryEntry>(HISTORY);
      if (direction === 'up') {
        await history.insertOne({ _id: migration.name, appliedAt: systemClock.now(), durationMs });
      } else {
        await history.deleteOne({ _id: migration.name });
      }
    }
    this.logger.log(`✔ ${label} (${durationMs} ms)`);
  }

  private async appliedMap(): Promise<Map<string, HistoryEntry>> {
    const entries = await this.connection.collection<HistoryEntry>(HISTORY).find().toArray();
    return new Map(entries.map((e) => [e._id, e]));
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const locks = this.connection.collection<{ _id: string; lockedAt: Date; host: string }>(LOCK);
    try {
      await locks.insertOne({ _id: 'lock', lockedAt: systemClock.now(), host: hostname() });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const lock = await locks.findOne({ _id: 'lock' });
      throw new Error(
        `Another migration run holds the lock (host ${lock?.host}, since ${lock?.lockedAt?.toISOString()}). ` +
          'If that run crashed, release it with `migrate unlock`.',
        { cause: error },
      );
    }
    try {
      return await work();
    } finally {
      await locks.deleteOne({ _id: 'lock' });
    }
  }
}
