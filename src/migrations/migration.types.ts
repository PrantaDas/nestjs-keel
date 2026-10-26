import type { Connection, mongo } from 'mongoose';

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
}

export interface Migration {
  /** Set from the file name (`20261012093000-backfill-wallet-ledger`). */
  name: string;
  description: string;
  up(ctx: MigrationContext): Promise<void>;
  down(ctx: MigrationContext): Promise<void>;
}

export type MigrationDefinition = Omit<Migration, 'name'>;
