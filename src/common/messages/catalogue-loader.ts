import { readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { registeredDuplicateKeyRules } from '@/common/exceptions/duplicate-keys';
import { type ErrorDefinition, registeredErrors } from '@/common/exceptions/error-registry';

/** The source (or compiled) root: `src/` under ts-jest, `dist/` when built. */
const ROOT = resolve(__dirname, '..', '..');
const EXT = extname(__filename);

/** Catalogues declared outside `*.errors.ts` files. */
const EXTRA_CATALOGUES = ['common/exceptions/error-codes', 'integrations/resilience/failure'];

/**
 * Imports every error catalogue of the app (`**\/*.errors.ts`, the shared codes, the integration
 * layer) so `registeredErrors()` and `registeredDuplicateKeyRules()` are complete, then returns them.
 * Used by the message catalogue export and the message guard tests; never at runtime.
 */
export function loadErrorCatalogues(): {
  errors: ErrorDefinition[];
  duplicateKeys: ReturnType<typeof registeredDuplicateKeyRules>;
} {
  const files = (readdirSync(ROOT, { recursive: true }) as string[])
    .filter((file) => file.endsWith(`.errors${EXT}`))
    .map((file) => join(ROOT, file));
  for (const file of [...files, ...EXTRA_CATALOGUES.map((file) => join(ROOT, `${file}${EXT}`))].sort()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(file);
  }
  return { errors: registeredErrors(), duplicateKeys: registeredDuplicateKeyRules() };
}
