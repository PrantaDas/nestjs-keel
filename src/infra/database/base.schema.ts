import type { SchemaOptions } from '@nestjs/mongoose';

/**
 * Defaults for every schema: timestamps on (from the injected clock, see database.module.ts), no
 * `__v`, `id` virtual off (responses expose `_id`).
 */
export const baseSchemaOptions: SchemaOptions = {
  timestamps: true,
  versionKey: false,
  id: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
};
