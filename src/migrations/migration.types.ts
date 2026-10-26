import type { Connection, mongo } from 'mongoose';
import type { TimeZone } from '@/common/time/time.types';

export interface MigrationLogger {
  log(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface MigrationContext {
  /** Native driver handle. Migrations use raw collections, never app models: models change over time, a migration must not. */
  db: mongo.Db;
  connection: Connection;
  /** When true, read and report only. Every migration must honour this. */
  dryRun: boolean;
  logger: MigrationLogger;
  /** The time policy of the deployment, for migrations that compute day keys. */
  businessTimeZone: TimeZone;
}

export interface Migration {
  /** Set from the file name (`20261026000000-notes-backfill-created-day`). */
  name: string;
  description: string;
  up(ctx: MigrationContext): Promise<void>;
  down(ctx: MigrationContext): Promise<void>;
}

export type MigrationDefinition = Omit<Migration, 'name'>;
