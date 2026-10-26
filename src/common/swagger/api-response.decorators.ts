import { applyDecorators, HttpStatus, Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import type { ReferenceObject, SchemaObject } from '@nestjs/swagger';
import type { ErrorDefinition } from '@/common/exceptions/error-registry';
import { ErrorDetailModel, ErrorEnvelopeModel, PaginationMetaModel, SuccessEnvelopeModel } from './envelope.models';
import { describeErrorExamples, errorExamples } from './error-examples';

/**
 * Placeholder status for the success response. `buildOpenApiDocument` replaces it with the
 * status the route really sends (`@HttpCode()`, else 201 for POST and 200 otherwise), so the
 * docs cannot drift from the handler.
 */
export const SUCCESS_STATUS_PLACEHOLDER = '2XX';

/** A response model class, a built-in (`String`, `Number`, `Boolean`) or a raw OpenAPI schema. */
export type ApiDataModel = Type<unknown> | StringConstructor | NumberConstructor | BooleanConstructor | SchemaObject;

export interface ApiEnvelopeOptions {
  description?: string;
  /** `data` may be `null` (e.g. "the current item, if any"). */
  nullable?: boolean;
  /** Only when the real status cannot be inferred; normally leave it out. */
  status?: number;
}

const PRIMITIVES = new Map<unknown, SchemaObject>([
  [String, { type: 'string' }],
  [Number, { type: 'number' }],
  [Boolean, { type: 'boolean' }],
]);

const isClass = (model: ApiDataModel): model is Type<unknown> => typeof model === 'function' && !PRIMITIVES.has(model);

function modelSchema(model: ApiDataModel): SchemaObject | ReferenceObject {
  if (typeof model !== 'function') return model;
  return PRIMITIVES.get(model) ?? { $ref: getSchemaPath(model) };
}

function nullableSchema(schema: SchemaObject | ReferenceObject, nullable?: boolean): SchemaObject | ReferenceObject {
  if (!nullable) return schema;
  return '$ref' in schema ? { type: 'object', nullable: true, allOf: [schema] } : { ...schema, nullable: true };
}

function successEnvelope(properties: Record<string, SchemaObject | ReferenceObject>): SchemaObject {
  return {
    allOf: [
      { $ref: getSchemaPath(SuccessEnvelopeModel) },
      { type: 'object', required: Object.keys(properties), properties },
    ],
  };
}

const extraModels = (...models: ApiDataModel[]): Type<unknown>[] => models.filter(isClass);

/** `{ success: true, message, data: Model }`. */
export function ApiEnvelope(model: ApiDataModel, options: ApiEnvelopeOptions = {}): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(SuccessEnvelopeModel, ...extraModels(model)),
    ApiResponse({
      status: options.status ?? SUCCESS_STATUS_PLACEHOLDER,
      description: options.description ?? 'Success',
      schema: successEnvelope({ data: nullableSchema(modelSchema(model), options.nullable) }),
    }),
  );
}

/** `{ success: true, message, data: Model[] }` (an unpaginated list). */
export function ApiEnvelopeArray(model: ApiDataModel, options: Omit<ApiEnvelopeOptions, 'nullable'> = {}) {
  return applyDecorators(
    ApiExtraModels(SuccessEnvelopeModel, ...extraModels(model)),
    ApiResponse({
      status: options.status ?? SUCCESS_STATUS_PLACEHOLDER,
      description: options.description ?? 'Success',
      schema: successEnvelope({ data: { type: 'array', items: modelSchema(model) } }),
    }),
  );
}

/**
 * `{ success: true, message, data: Model[], meta: PaginationMeta }` (a `PaginatedResult`). `model` may
 * be a raw schema for mixed rows (e.g. `{ oneOf: [...] }`; register those classes with `@ApiExtraModels`).
 */
export function ApiPaginated(model: ApiDataModel, options: Omit<ApiEnvelopeOptions, 'nullable'> = {}) {
  return applyDecorators(
    ApiExtraModels(SuccessEnvelopeModel, PaginationMetaModel, ...extraModels(model)),
    ApiResponse({
      status: options.status ?? SUCCESS_STATUS_PLACEHOLDER,
      description: options.description ?? 'One page of results',
      schema: successEnvelope({
        data: { type: 'array', items: modelSchema(model) },
        meta: { $ref: getSchemaPath(PaginationMetaModel) },
      }),
    }),
  );
}

/**
 * `{ success: true, message, data: Model, meta: PaginationMeta }` (a `PaginatedObject`): one page whose
 * `data` is an object holding the rows plus page context (e.g. a leaderboard's `items` and `me`).
 */
export function ApiPaginatedObject(model: Type<unknown>, options: Omit<ApiEnvelopeOptions, 'nullable'> = {}) {
  return applyDecorators(
    ApiExtraModels(SuccessEnvelopeModel, PaginationMetaModel, model),
    ApiResponse({
      status: options.status ?? SUCCESS_STATUS_PLACEHOLDER,
      description: options.description ?? 'One page of results',
      schema: successEnvelope({
        data: modelSchema(model),
        meta: { $ref: getSchemaPath(PaginationMetaModel) },
      }),
    }),
  );
}

/** `{ success: true, message, data: null }`: the handler resolves nothing but the status is not 204. */
export function ApiEnvelopeNull(options: Omit<ApiEnvelopeOptions, 'nullable'> = {}) {
  return applyDecorators(
    ApiExtraModels(SuccessEnvelopeModel),
    ApiResponse({
      status: options.status ?? SUCCESS_STATUS_PLACEHOLDER,
      description: options.description ?? 'Success (no data)',
      schema: successEnvelope({ data: { type: 'object', nullable: true, enum: [null], description: 'Always null' } }),
    }),
  );
}

/** 204, no body (`@HttpCode(HttpStatus.NO_CONTENT)` routes). */
export function ApiNoContent(description = 'Done; no body') {
  return ApiResponse({ status: HttpStatus.NO_CONTENT, description });
}

/**
 * Documents the domain errors a route can return, grouped by status, as the shared error
 * envelope with one example per code. The generic errors every route shares (validation,
 * authentication, roles, rate limit) are added by `buildOpenApiDocument` from the
 * route's real guard metadata, so list only what the route's own service throws.
 */
export function ApiStandardErrors(...errors: ErrorDefinition[]): MethodDecorator & ClassDecorator {
  const byStatus = new Map<number, ErrorDefinition[]>();
  for (const error of errors) byStatus.set(error.status, [...(byStatus.get(error.status) ?? []), error]);

  return applyDecorators(
    ApiExtraModels(ErrorEnvelopeModel, ErrorDetailModel),
    ...[...byStatus].map(([status, definitions]) => {
      const examples = errorExamples(definitions);
      return ApiResponse({
        status,
        description: describeErrorExamples(examples),
        schema: { $ref: getSchemaPath(ErrorEnvelopeModel) },
        examples,
      });
    }),
  );
}
