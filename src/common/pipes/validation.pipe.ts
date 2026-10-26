import { ValidationError, ValidationPipe } from '@nestjs/common';
import { ErrorDetail, ValidationException } from '@/common/exceptions';
import { findRule, validationMessage } from './validation-messages';

/** Rules that say what kind of value a field takes; when one fails, the field's other rules are noise. */
const KIND_RULES = new Set([
  'isString',
  'isInt',
  'isNumber',
  'isNumberString',
  'isBoolean',
  'isArray',
  'isObject',
  'isDate',
  'isEnum',
  'isIn',
  'isMongoId',
  'isEmail',
  'isUrl',
  'isDayKey',
  'isInstant',
  'isTimeZone',
  'isPhone',
  'nestedValidation',
]);

const isMissing = (value: unknown) => value === undefined || value === null || value === '';

/** DTO class name of the validated object, for `Dto.property` labels. */
const targetName = (target: unknown): string | undefined =>
  target && typeof target === 'object' && !Array.isArray(target) ? target.constructor.name : undefined;

/** The human messages for one field's failed rules: one when the value is missing or of the wrong kind. */
function fieldMessages(error: ValidationError, field: string): string[] {
  const failed = Object.entries(error.constraints ?? {}).map(([type, provided]) => {
    const rule = findRule(error.target, error.property, type);
    return {
      type,
      each: rule?.each ?? false,
      message: validationMessage({
        type,
        field,
        provided,
        constraints: rule?.constraints,
        each: rule?.each,
        target: targetName(error.target),
      }),
    };
  });
  if (!failed.length) return [];
  if (failed.some((f) => f.type === 'whitelistValidation')) return [validationMessage({ type: 'whitelistValidation' })];
  if ('value' in error && isMissing(error.value)) {
    return [validationMessage({ type: 'isDefined', field, target: targetName(error.target) })];
  }
  const kind = failed.find((f) => KIND_RULES.has(f.type) && !f.each);
  if (kind) return [kind.message];
  return [...new Set(failed.map((f) => f.message))];
}

/**
 * Flattens nested class-validator errors into `{ field: 'address.city', message }` entries, with
 * human messages built from each rule (see `validation-messages.ts`). Errors carry their `target`
 * and `value` (validate with `validationError: { target: true, value: true }`) so each rule's
 * arguments can be read and a missing value reported once as "is required"; without them the rule's
 * own text is humanised. Neither the target nor the value is ever sent to the client.
 */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): ErrorDetail[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = fieldMessages(error, field).map((message) => ({ field, message }));
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

/** Options for direct `validate()` calls that report through `flattenValidationErrors`. */
export const VALIDATION_ERROR_OPTIONS = { target: true, value: true } as const;

/**
 * Strict DTO validation for HTTP and sockets: unknown fields are rejected, payloads are
 * transformed into DTO instances, and every failing field is reported.
 */
export const createValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: false,
    validationError: VALIDATION_ERROR_OPTIONS,
    exceptionFactory: (errors) => new ValidationException(flattenValidationErrors(errors)),
  });
