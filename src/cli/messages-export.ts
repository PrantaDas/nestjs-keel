import '@/common/time/force-utc';
import '@/bootstrap/openapi-env';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOpenApiDocument } from '@/bootstrap/openapi';
import { loadErrorCatalogues } from '@/common/messages/catalogue-loader';
import { collectMessageCatalogue, renderMessageCatalogue } from '@/common/messages/message-catalogue';

/**
 * Writes the catalogue of every message the API shows to people (errors, validation wording,
 * duplicate values, success messages) for review. Needs no database or Redis.
 *
 *   pnpm messages:export [output path, default ./docs/api/messages.md]
 */
async function main(): Promise<void> {
  const output = resolve(process.argv[2] ?? 'docs/api/messages.md');
  const { errors, duplicateKeys } = loadErrorCatalogues();
  const { document, routes } = await createOpenApiDocument();
  const catalogue = collectMessageCatalogue(document, routes, errors, duplicateKeys);
  writeFileSync(output, renderMessageCatalogue(catalogue));
  console.log(`Wrote ${output} (${catalogue.errors.length} errors, ${catalogue.successes.length} routes)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
