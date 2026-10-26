import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Migration, MigrationDefinition } from './migration.types';

const MIGRATION_FILE = /^\d{14}-[a-z0-9-]+\.js$/;

/** Loads compiled migrations from `dist/migrations/scripts`, ordered by their timestamp prefix. */
export function loadMigrations(dir = join(__dirname, 'scripts')): Migration[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((file) => MIGRATION_FILE.test(file))
    .sort()
    .map((file) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(join(dir, file)) as { default?: MigrationDefinition };
      const definition = mod.default;
      if (!definition || typeof definition.up !== 'function' || typeof definition.down !== 'function') {
        throw new Error(`Migration ${file} must default-export { description, up, down }`);
      }
      return { ...definition, name: basename(file, '.js') };
    });
}
