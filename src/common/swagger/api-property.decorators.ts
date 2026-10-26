import { ApiProperty, ApiPropertyOptions, ReferenceObject, SchemaObject } from '@nestjs/swagger';

/*
 * Property decorators for response classes, so the same JSON types are described the same way
 * everywhere. The project has no Swagger CLI plugin: every property needs a decorator, and any
 * type the compiler cannot express at runtime (unions, `| null`, arrays, ObjectIds, Dates, maps)
 * needs an explicit `type`.
 */

type Options = Omit<ApiPropertyOptions, 'type' | 'format' | 'pattern'> & { description?: string };

export const OBJECT_ID_PATTERN = '^[a-f0-9]{24}$';
export const DAY_KEY_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

/** Example for one value, or a one-item list when the property is an array. */
const exampleFor = (value: string, options: Options): string | string[] => (options.isArray ? [value] : value);

/** A MongoDB ObjectId, serialised as its 24-character hex string. */
export const ApiObjectIdProperty = (options: Options = {}): PropertyDecorator =>
  ApiProperty({
    example: exampleFor('665f1c2e9b1e8a0012345678', options),
    ...options,
    type: String,
    pattern: OBJECT_ID_PATTERN,
  } as ApiPropertyOptions);

/** An instant: ISO-8601 in UTC (`Date` on the server). */
export const ApiDateTimeProperty = (options: Options = {}): PropertyDecorator =>
  ApiProperty({
    example: exampleFor('2026-10-25T14:30:00.000Z', options),
    ...options,
    type: String,
    format: 'date-time',
  } as ApiPropertyOptions);

/** A `DayKey` (`YYYY-MM-DD`): a business day, computed in `BUSINESS_TIMEZONE` at write time. */
export const ApiDayKeyProperty = (options: Options = {}): PropertyDecorator =>
  ApiProperty({
    example: exampleFor('2026-10-25', options),
    description: 'Business day (`BUSINESS_TIMEZONE`), `YYYY-MM-DD`',
    ...options,
    type: String,
    pattern: DAY_KEY_PATTERN,
  } as ApiPropertyOptions);

/** A string-keyed map, e.g. `Record<string, string>`; `values` describes one value. */
export const ApiMapProperty = (
  values: SchemaObject | ReferenceObject | true,
  options: Options = {},
): PropertyDecorator => ApiProperty({ ...options, type: 'object', additionalProperties: values } as ApiPropertyOptions);

/** Free-form JSON object (audit snapshots, provider payloads): no fixed shape on purpose. */
export const ApiFreeFormProperty = (options: Options = {}): PropertyDecorator =>
  ApiProperty({
    description: 'Free-form JSON object',
    ...options,
    type: 'object',
    additionalProperties: true,
  } as ApiPropertyOptions);
