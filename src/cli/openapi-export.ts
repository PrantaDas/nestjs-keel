import '@/common/time/force-utc';
import '@/bootstrap/openapi-env';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOpenApiDocument } from '@/bootstrap/openapi';
import { findContractViolations } from '@/common/swagger/openapi-contract';

/**
 * Writes the API's OpenAPI document for client code generation (admin frontend, Postman).
 * Needs no database or Redis: the app is scanned in Nest's preview mode.
 *
 *   pnpm openapi:export [output path, default ./openapi.json]
 */
async function main(): Promise<void> {
  const output = resolve(process.argv[2] ?? 'openapi.json');
  const { document, routes } = await createOpenApiDocument();

  const violations = findContractViolations(document, routes);
  if (violations.length) {
    console.warn(`OpenAPI contract: ${violations.length} problem(s); see test/unit/openapi-contract.spec.ts`);
    for (const violation of violations) console.warn(`  - ${violation}`);
  }

  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Wrote ${output} (${routes.length} operations)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
