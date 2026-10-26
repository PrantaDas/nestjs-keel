import { HttpStatus } from '@nestjs/common';

export interface ErrorSpec {
  code: number;
  status: HttpStatus;
  message: string;
}

export interface ErrorDefinition extends ErrorSpec {
  /** Machine-readable key, e.g. `MISSING_BEARER_TOKEN`. */
  key: string;
  domain: string;
}

const codeOwners = new Map<number, string>();
const definitions = new Map<number, ErrorDefinition>();

/** Every error declared so far, by code (message guard tests, the message catalogue). */
export function registeredErrors(): ErrorDefinition[] {
  return [...definitions.values()].sort((a, b) => a.code - b.code);
}

/**
 * Declares a domain's error catalogue. Runs at import time, so a code that is
 * duplicated or outside the domain's range stops the app from booting.
 *
 * @example
 * export const NotesErrors = defineErrors('notes', [5000, 5099], {
 *   NOTE_NOT_FOUND: { code: 5000, status: HttpStatus.NOT_FOUND, message: "We couldn't find that note." },
 * });
 */
export function defineErrors<const T extends Record<string, ErrorSpec>>(
  domain: string,
  [min, max]: readonly [number, number],
  specs: T,
): { readonly [K in keyof T]: ErrorDefinition } {
  const result = {} as Record<string, ErrorDefinition>;

  for (const [key, spec] of Object.entries(specs)) {
    if (spec.code < min || spec.code > max) {
      throw new Error(`[errors] ${domain}.${key} code ${spec.code} is outside range ${min}-${max}`);
    }
    const owner = codeOwners.get(spec.code);
    if (owner) {
      throw new Error(`[errors] code ${spec.code} used by both ${owner} and ${domain}.${key}`);
    }
    codeOwners.set(spec.code, `${domain}.${key}`);
    result[key] = { ...spec, key, domain };
    definitions.set(spec.code, result[key]);
  }

  return result as { readonly [K in keyof T]: ErrorDefinition };
}
