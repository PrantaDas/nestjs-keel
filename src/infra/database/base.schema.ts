import type { SchemaOptions } from '@nestjs/mongoose';

/** Defaults for every schema: timestamps on, no `__v`, `id` virtual off (we expose `_id`). */
export const baseSchemaOptions: SchemaOptions = {
  timestamps: true,
  versionKey: false,
  id: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
};
