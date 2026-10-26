import { getMetadataStorage, type MetadataStorage, type ValidationArguments, ValidationTypes } from 'class-validator';
import { fieldLabel } from '@/common/messages/field-labels';

/** One registered validation rule (class-validator does not export the class itself). */
export type ValidationMetadata = ReturnType<MetadataStorage['getTargetValidationMetadatas']>[number];

/**
 * One wording for every validation rule, so `details[].message` reads the same everywhere:
 * "Title is required.", "Title must be 200 characters or fewer.", "This field isn't allowed.".
 *
 * Messages are built from the rule (class-validator constraint name and its arguments) and the
 * field's human label; the text written next to a decorator is only used for rules this file does
 * not know (custom validators, patterns), after humanising its leading field name. A decorator
 * message written as a full sentence ("Choose at least one day.") is used as it is.
 */

export interface RuleInput {
  /** Constraint name as class-validator reports it (`maxLength`, `isDayKey`, `whitelistValidation`). */
  type: string;
  /** Request path of the field (`title`, `schedule.recurring.endDate`). */
  field?: string;
  /** Arguments of the rule (`[200]` for `@MaxLength(200)`), when known. */
  constraints?: readonly unknown[];
  /** The rule applies to every item of an array (`{ each: true }`). */
  each?: boolean;
  /** The message class-validator produced (decorator text or its default). */
  provided?: string;
  /** Name of the DTO class, for `Dto.property` labels. */
  target?: string;
}

const MAX_LISTED_OPTIONS = 12;

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);
const isSentence = (text: string) => /^[A-Z][\s\S]*[.!?]$/.test(text.trim());

function options(values: unknown): string[] | undefined {
  if (Array.isArray(values)) return values.map(String);
  if (values && typeof values === 'object') {
    const all = Object.values(values as Record<string, unknown>);
    // Numeric TypeScript enums map both ways; keep the values only.
    const numeric = all.filter((v) => typeof v === 'number');
    return (numeric.length ? numeric : all).map(String);
  }
  return undefined;
}

function oneOf(label: string, values: string[] | undefined, each: boolean): string {
  const subject = each ? `Each item in ${lowerFirst(label)}` : label;
  if (!values?.length || values.length > MAX_LISTED_OPTIONS) return `${subject} isn't one of the allowed options.`;
  return `${subject} must be one of: ${values.join(', ')}.`;
}

/** `{Label} must <rule>.` for rules phrased the same way with or without `each`. */
function must(label: string, rule: string, each: boolean): string {
  return each ? `Each item in ${lowerFirst(label)} must ${rule}.` : `${label} must ${rule}.`;
}

type Builder = (label: string, args: readonly unknown[], each: boolean) => string;

const RULES: Readonly<Record<string, Builder>> = {
  isDefined: (l) => `${l} is required.`,
  isNotEmpty: (l, _a, each) => (each ? `${l} can't contain empty items.` : `${l} is required.`),
  arrayNotEmpty: (l) => `${l} needs at least one item.`,
  isString: (l, _a, each) => must(l, 'be text', each),
  maxLength: (l, [max], each) => must(l, `be ${plural(Number(max), 'character')} or fewer`, each),
  minLength: (l, [min], each) =>
    Number(min) === 1
      ? each
        ? `${l} can't contain empty items.`
        : `${l} is required.`
      : must(l, `be at least ${plural(Number(min), 'character')}`, each),
  isLength: (l, [min, max], each) => must(l, `be between ${String(min)} and ${plural(Number(max), 'character')}`, each),
  isInt: (l, _a, each) => must(l, 'be a whole number', each),
  isNumber: (l, _a, each) => must(l, 'be a number', each),
  isNumberString: (l, _a, each) => must(l, 'be a number', each),
  isPositive: (l, _a, each) => must(l, 'be more than 0', each),
  min: (l, [min], each) => must(l, `be ${String(min)} or more`, each),
  max: (l, [max], each) => must(l, `be ${String(max)} or less`, each),
  isBoolean: (l, _a, each) => must(l, 'be true or false', each),
  isEnum: (l, [entity], each) => oneOf(l, options(entity), each),
  isIn: (l, [values], each) => oneOf(l, options(values), each),
  equals: (l, [value]) => `${l} must be ${String(value)}.`,
  isMongoId: (l, _a, each) => (each ? `${l} contains an item that isn't valid.` : `${l} isn't valid.`),
  isEmail: (l, _a, each) =>
    !each && /e-?mail/i.test(l) ? 'Enter a valid email address.' : must(l, 'be a valid email address', each),
  emptyOrEmail: (l) => `${l} must be a valid email address, or left empty.`,
  isUrl: (l, _a, each) => must(l, 'be a valid web address', each),
  emptyOrUrl: (l) => `${l} must be a full web address such as https://example.com, or left empty.`,
  isFQDN: (l, _a, each) => must(l, 'be a valid domain name', each),
  isArray: (l) => `${l} must be a list.`,
  arrayMinSize: (l, [min]) =>
    Number(min) === 1 ? `${l} needs at least one item.` : `${l} needs at least ${plural(Number(min), 'item')}.`,
  arrayMaxSize: (l, [max]) => `${l} can have at most ${plural(Number(max), 'item')}.`,
  arrayUnique: (l) => `${l} can't contain the same item twice.`,
  isObject: (l) => `${l} isn't in the right format.`,
  nestedValidation: (l) => `${l} isn't in the right format.`,
  isDate: (l, _a, each) => must(l, 'be a valid date', each),
  isDateString: (l, _a, each) => must(l, 'be a valid date', each),
  isISO8601: (l, _a, each) => must(l, 'be a valid date', each),
  isDayKey: (l, _a, each) => must(l, 'use the format YYYY-MM-DD, for example 2026-10-12', each),
  isInstant: (l, _a, each) => must(l, 'be a date and time with a time zone, for example 2026-10-12T14:30:00Z', each),
  isInstantArray: (l) => `${l} must be a list of dates and times with a time zone, for example 2026-10-12T14:30:00Z.`,
  isTimeZone: (l, _a, each) =>
    must(l, /zone/i.test(l) ? 'be a name such as Europe/London' : 'be a time zone such as Europe/London', each),
  isPhone: (l) => `${l} must be a valid mobile number with its country code, for example +14155550123.`,
  isHexColor: (l, _a, each) => must(l, 'be a colour code such as #6949FF', each),
  isStrongPassword: (l) => `${l} must be at least 10 characters and include a letter and a number.`,
  whitelistValidation: () => "This field isn't allowed.",
  unknownValue: () => "Some of the details aren't valid. Please check them and try again.",
};

/** Lower-case "the field name" at the start of a decorator message becomes the human label. */
function humanise(provided: string, field: string | undefined, label: string): string {
  let text = provided.trim().replace(/^each value in /i, '');
  const names = [field, field?.split('.').at(-1)].filter((name): name is string => Boolean(name));
  for (const name of names) {
    if (text.startsWith(`${name} `)) {
      text = `${label}${text.slice(name.length)}`;
      break;
    }
  }
  text = text.replace(/\s*\(([^)]*)\)\s*$/, ' ($1)');
  text = text[0].toUpperCase() + text.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The public message for one failed rule. */
export function validationMessage({
  type,
  field,
  constraints = [],
  each = false,
  provided,
  target,
}: RuleInput): string {
  const label = fieldLabel(field, target);
  if (provided && isSentence(provided)) return provided.trim();
  const rule = RULES[type];
  if (rule) return rule(label, constraints, each || /^each value in /i.test(provided ?? ''));
  if (provided?.trim()) return humanise(provided, field, label);
  return `${label} isn't valid.`;
}

// ── class-validator metadata lookup ─────────────────────────────────────────

/** Constraint name class-validator reports for a rule (the custom constraint's name, else its type). */
export function constraintType(metadata: ValidationMetadata): string {
  if (metadata.type === ValidationTypes.CUSTOM_VALIDATION) {
    const [constraint] = getMetadataStorage().getTargetValidatorConstraints(metadata.constraintCls);
    if (constraint?.name) return constraint.name;
  }
  return metadata.name ?? metadata.type;
}

/**
 * The text class-validator would report for a rule on `property` (the decorator's message, else the
 * constraint's default message), for checks that walk every registered rule.
 */
export function decoratorMessage(metadata: ValidationMetadata, property = metadata.propertyName): string | undefined {
  const args: ValidationArguments = {
    targetName: typeof metadata.target === 'function' ? metadata.target.name : String(metadata.target),
    property,
    object: {},
    value: undefined,
    constraints: metadata.constraints,
  };
  const { message } = metadata;
  if (typeof message === 'string' && message) return message;
  if (typeof message === 'function') return message(args);
  if (metadata.type !== ValidationTypes.CUSTOM_VALIDATION) return undefined;
  const [constraint] = getMetadataStorage().getTargetValidatorConstraints(metadata.constraintCls);
  const instance = constraint?.instance as { defaultMessage?: (args: ValidationArguments) => string } | undefined;
  return instance?.defaultMessage?.(args) || undefined;
}

/** The public message of a registered rule, as a request failing it would get. */
export function ruleMessage(metadata: ValidationMetadata, field = metadata.propertyName): string {
  return validationMessage({
    type: constraintType(metadata),
    field,
    constraints: metadata.constraints,
    each: metadata.each,
    provided: decoratorMessage(metadata, field),
    target: typeof metadata.target === 'function' ? metadata.target.name : undefined,
  });
}

/** Rule types that never report an error themselves (`@IsOptional`, `@ValidateIf`, `@Allow`). */
const SILENT_TYPES = new Set<string>([ValidationTypes.CONDITIONAL_VALIDATION, ValidationTypes.WHITELIST]);

/** Every validation rule that can fail, of all DTO classes imported so far. */
export function registeredRules(): ValidationMetadata[] {
  const storage = getMetadataStorage() as unknown as { validationMetadatas: Map<unknown, ValidationMetadata[]> };
  return [...storage.validationMetadatas.values()].flat().filter((rule) => !SILENT_TYPES.has(rule.type));
}

/** Example wording of the common rules, for the message catalogue. */
export function exampleRuleMessages(): Array<{ rule: string; example: string }> {
  const examples: Array<[string, RuleInput]> = [
    ['Required', { type: 'isNotEmpty', field: 'title' }],
    ['Text', { type: 'isString', field: 'title' }],
    ['Maximum length', { type: 'maxLength', field: 'title', constraints: [200] }],
    ['Minimum length', { type: 'minLength', field: 'password', constraints: [8] }],
    ['Whole number', { type: 'isInt', field: 'quantity' }],
    ['Minimum', { type: 'min', field: 'quantity', constraints: [1] }],
    ['Maximum', { type: 'max', field: 'quantity', constraints: [1000] }],
    ['Yes / no', { type: 'isBoolean', field: 'isActive' }],
    ['One of a list', { type: 'isEnum', field: 'status', constraints: [{ DRAFT: 'draft', PUBLISHED: 'published' }] }],
    ['Reference to an item', { type: 'isMongoId', field: 'noteId' }],
    ['Several references', { type: 'isMongoId', field: 'tagIds', each: true }],
    ['Email', { type: 'isEmail', field: 'email' }],
    ['Web address', { type: 'isUrl', field: 'imageUrl' }],
    ['List', { type: 'isArray', field: 'tags' }],
    ['List size', { type: 'arrayMaxSize', field: 'tags', constraints: [20] }],
    ['No repeats', { type: 'arrayUnique', field: 'tags' }],
    ['Day', { type: 'isDayKey', field: 'day' }],
    ['Date and time', { type: 'isInstant', field: 'remindAt' }],
    ['Time zone', { type: 'isTimeZone', field: 'timeZone' }],
    ['Phone number', { type: 'isPhone', field: 'phone' }],
    ['Nested object', { type: 'nestedValidation', field: 'reminder' }],
    ['Unknown field', { type: 'whitelistValidation', field: 'isAdmin' }],
  ];
  return examples.map(([rule, input]) => ({ rule, example: validationMessage(input) }));
}

/** The rule behind one reported constraint of `property` on the validated object, if registered. */
export function findRule(target: unknown, property: string, type: string): ValidationMetadata | undefined {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const metadatas = getMetadataStorage().getTargetValidationMetadatas(target.constructor, '', true, false);
  return metadatas.find((metadata) => metadata.propertyName === property && constraintType(metadata) === type);
}
