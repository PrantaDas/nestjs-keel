/**
 * Friendly answers for unique-index conflicts (MongoDB E11000) that reach the global error mapper,
 * typically a race the service's own "is it taken?" check could not see. Modules declare their
 * unique indexes next to their error catalogue; the mapper turns a matching conflict into a 409
 * that names the request field a person can change, never the index or an internal key.
 *
 * @example
 * defineDuplicateKeys('users', [
 *   { fields: ['email'], field: 'email', message: UsersErrors.EMAIL_TAKEN.message },
 * ]);
 */

export interface DuplicateKeyRule {
  /** Fields of the unique index, as declared on the schema (`['day', 'language']`). */
  fields: readonly string[];
  /** The public request field a person changes to fix it (`title`), when there is one. */
  field?: string;
  /** Full sentence shown as `errorMessage` (and as the field's `details[].message`). */
  message: string;
}

export interface DuplicateKeyAnswer {
  message: string;
  field?: string;
}

interface RegisteredRule extends DuplicateKeyRule {
  collection: string;
}

const rules: RegisteredRule[] = [];

const signature = (fields: readonly string[]) => [...fields].sort().join(',');

/** Registers the unique indexes of a collection (runs at import time, like `defineErrors`). */
export function defineDuplicateKeys(collection: string, collectionRules: readonly DuplicateKeyRule[]): void {
  for (const rule of collectionRules) {
    const duplicate = rules.find((r) => r.collection === collection && signature(r.fields) === signature(rule.fields));
    if (duplicate) {
      throw new Error(`[errors] duplicate-key rule for ${collection}(${signature(rule.fields)}) declared twice`);
    }
    rules.push({ ...rule, collection });
  }
}

/** Every registered rule (message guard tests and the message catalogue). */
export function registeredDuplicateKeyRules(): ReadonlyArray<Readonly<RegisteredRule>> {
  return rules;
}

interface DuplicateKeyErrorShape {
  code?: unknown;
  keyPattern?: Record<string, unknown>;
  keyValue?: Record<string, unknown>;
  errmsg?: unknown;
  message?: unknown;
  errorResponse?: { errmsg?: unknown; keyPattern?: Record<string, unknown> };
  cause?: unknown;
}

/** The E11000 error itself, also when wrapped once as `cause` (driver / Mongoose / transactions). */
export function duplicateKeyError(error: unknown): DuplicateKeyErrorShape | undefined {
  const err = error as DuplicateKeyErrorShape | null | undefined;
  if (!err || typeof err !== 'object') return undefined;
  if (err.code === 11000) return err;
  const cause = err.cause as DuplicateKeyErrorShape | undefined;
  return cause && typeof cause === 'object' && cause.code === 11000 ? cause : undefined;
}

const COLLECTION_IN_MESSAGE = /collection: [^.\s]+\.(\S+) index:/;

/** The registered answer for a duplicate-key error, if its collection and index are known. */
export function describeDuplicateKey(error: DuplicateKeyErrorShape): DuplicateKeyAnswer | undefined {
  const pattern = error.keyPattern ?? error.errorResponse?.keyPattern ?? error.keyValue;
  if (!pattern) return undefined;
  const fields = signature(Object.keys(pattern));

  const text = [error.errmsg, error.errorResponse?.errmsg, error.message].find(
    (m): m is string => typeof m === 'string',
  );
  const collection = text ? COLLECTION_IN_MESSAGE.exec(text)?.[1] : undefined;

  const candidates = rules.filter((rule) => signature(rule.fields) === fields);
  const match = collection
    ? candidates.find((rule) => rule.collection === collection)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  return match ? { message: match.message, field: match.field } : undefined;
}
