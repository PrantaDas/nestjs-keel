import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength, ValidateBy, type ValidationOptions } from 'class-validator';

/** E.164: `+`, country code, up to 15 digits in total. */
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/** Removes spaces, dashes and brackets people type (`+1 (415) 555-0123` → `+14155550123`). */
export function normalizePhone(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/[\s().-]/g, '') : value;
}

/** A mobile number in E.164 after normalisation. Validation message: `isPhone` in validation-messages.ts. */
export function IsPhone(options?: ValidationOptions): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => normalizePhone(value)),
    ValidateBy(
      {
        name: 'isPhone',
        validator: { validate: (value: unknown) => typeof value === 'string' && E164_PATTERN.test(value) },
      },
      options,
    ),
  );
}

/** A trimmed, lower-cased e-mail address of at most 254 characters. */
export function IsNormalizedEmail(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)),
    IsEmail(),
    MaxLength(254),
  );
}

/** At least 10 characters with a letter and a digit, at most 128 (scrypt input stays bounded). */
export function IsStrongPassword(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isStrongPassword',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          value.length >= 10 &&
          value.length <= 128 &&
          /[A-Za-z]/.test(value) &&
          /\d/.test(value),
      },
    },
    options,
  );
}
