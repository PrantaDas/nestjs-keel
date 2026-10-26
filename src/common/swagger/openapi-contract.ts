import { HttpStatus } from '@nestjs/common';
import { DECORATORS } from '@nestjs/swagger';
import type { OpenAPIObject, OperationObject, ReferenceObject, ResponseObject, SchemaObject } from '@nestjs/swagger';
import { SUCCESS_STATUS_PLACEHOLDER } from './api-response.decorators';
import type { RouteMetadata } from './openapi-document';

/*
 * The documentation contract every route must meet, so generated clients get real types:
 * a unique camelCase operationId, a summary and tags, bearer auth exactly when the guard wants a
 * token, the real success status with a concrete schema (no `{}` / bare `object` / untyped array).
 * Used by the contract test; returns human-readable violations, empty when the document is clean.
 */

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const;
const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;

type Schema = SchemaObject | ReferenceObject;

function schemaProblems(root: Schema, document: OpenAPIObject): string[] {
  const problems: string[] = [];
  const components = (document.components?.schemas ?? {}) as Record<string, Schema>;
  const seen = new Set<string>();

  const visit = (schema: Schema | undefined, path: string): void => {
    if (!schema || Object.keys(schema).length === 0) {
      problems.push(`${path}: empty schema`);
      return;
    }
    if ('$ref' in schema) {
      const name = schema.$ref.replace('#/components/schemas/', '');
      if (!components[name]) problems.push(`${path}: $ref to missing schema ${name}`);
      else if (!seen.has(name)) {
        seen.add(name);
        visit(components[name], `#${name}`);
      }
      return;
    }
    const composed = [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])];
    composed.forEach((part, index) => visit(part, `${path}<${index}>`));
    if (schema.type === 'array') {
      visit(schema.items, `${path}[]`);
      return;
    }
    const properties = Object.entries(schema.properties ?? {});
    for (const [key, value] of properties) visit(value, `${path}.${key}`);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      visit(schema.additionalProperties, `${path}{}`);
    }
    const hasShape =
      composed.length > 0 ||
      properties.length > 0 ||
      schema.additionalProperties !== undefined ||
      schema.enum !== undefined ||
      (schema.type !== undefined && schema.type !== 'object');
    if (!hasShape) problems.push(`${path}: untyped ${schema.type ? 'object' : 'schema'} (no properties)`);
  };

  visit(root, 'body');
  return problems;
}

function operationProblems(route: RouteMetadata, operation: OperationObject, document: OpenAPIObject): string[] {
  const problems: string[] = [];
  if (!operation.summary?.trim()) problems.push('missing summary');
  if (!operation.tags?.length) problems.push('missing tags');

  const hasBearer = (operation.security ?? []).some((requirement) => 'bearer' in requirement);
  const hasApiKey = (operation.security ?? []).some((requirement) => 'apiKey' in requirement);
  if (route.apiKey) {
    if (!hasApiKey) problems.push("is @ApiKeyAuth() but has no @ApiSecurity('apiKey')");
    if (hasBearer) problems.push('is @ApiKeyAuth() but declares @ApiBearerAuth()');
  } else {
    if (!route.isPublic && !hasBearer) problems.push('needs a token but has no @ApiBearerAuth()');
    if (route.isPublic && hasBearer) problems.push('is @Public() but declares @ApiBearerAuth()');
  }

  const responses = operation.responses as Record<string, ResponseObject>;
  if (responses[SUCCESS_STATUS_PLACEHOLDER]) problems.push('success status placeholder was not resolved');
  const successStatuses = Object.keys(responses).filter((status) => /^2\d\d$/.test(status));
  if (successStatuses.length !== 1 || successStatuses[0] !== String(route.successStatus)) {
    problems.push(
      `documents success ${successStatuses.join(',') || 'none'} but the route returns ${route.successStatus}`,
    );
  }

  const success = responses[String(route.successStatus)];
  if (success && route.successStatus === Number(HttpStatus.NO_CONTENT)) {
    if (success.content) problems.push('204 response must not have a body');
  } else if (success) {
    const content = Object.values(success.content ?? {});
    if (!content.length || content.some((media) => !media.schema)) problems.push('success response has no schema');
    for (const media of content) {
      if (media.schema) problems.push(...schemaProblems(media.schema, document));
    }
  }
  return problems;
}

const BUILT_INS = new Set<unknown>([String, Number, Boolean, Date, Object, Array, Buffer, Function, Promise]);

/** A documented class (its constructor). */
type ModelClass = { name: string; prototype: object };

const readMetadata = (key: string, target: object, property?: string): unknown =>
  property === undefined ? Reflect.getMetadata(key, target) : Reflect.getMetadata(key, target, property);

/** Classes a decorator `type` points at (`Foo`, `[Foo]`, `() => Foo`, `() => [Foo]`). */
function modelsOf(type: unknown): ModelClass[] {
  if (Array.isArray(type)) return type.flatMap(modelsOf);
  if (typeof type !== 'function' || BUILT_INS.has(type)) return [];
  if (!type.prototype) return modelsOf((type as () => unknown)());
  return [type];
}

function schemaName(model: ModelClass): string {
  const custom = Reflect.getOwnMetadata(DECORATORS.API_SCHEMA, model) as { name?: string }[] | undefined;
  return custom?.at(-1)?.name ?? model.name;
}

/**
 * Swagger names a component after its class (or `enumName`), and silently keeps only the first of
 * two with the same name. Finds every documented class (responses, extra models, bodies, nested
 * properties) and reports names shared by different classes, or enum names with different values.
 */
function findSchemaNameCollisions(routes: RouteMetadata[]): string[] {
  const queue: ModelClass[] = [];
  for (const { target } of routes) {
    const prototype = target.controller.prototype as object;
    const name = Object.getOwnPropertyNames(prototype).find(
      (key) => (prototype as Record<string, unknown>)[key] === target.handler,
    );
    queue.push(
      ...modelsOf(readMetadata(DECORATORS.API_EXTRA_MODELS, target.handler)),
      ...modelsOf(readMetadata(DECORATORS.API_EXTRA_MODELS, target.controller)),
      ...modelsOf(name ? readMetadata('design:paramtypes', prototype, name) : []),
      ...Object.values(
        (readMetadata(DECORATORS.API_RESPONSE, target.handler) ?? {}) as Record<string, { type?: unknown }>,
      ).flatMap((response) => modelsOf(response.type)),
    );
  }

  const owners = new Map<string, Set<ModelClass>>();
  const enums = new Map<string, Set<string>>();
  const seen = new Set<ModelClass>();
  while (queue.length) {
    const model = queue.pop()!;
    if (seen.has(model)) continue;
    seen.add(model);
    const name = schemaName(model);
    owners.set(name, (owners.get(name) ?? new Set()).add(model));
    const keys = (readMetadata(DECORATORS.API_MODEL_PROPERTIES_ARRAY, model.prototype) ?? []) as string[];
    for (const key of keys) {
      const property = (readMetadata(DECORATORS.API_MODEL_PROPERTIES, model.prototype, key.slice(1)) ?? {}) as {
        type?: unknown;
        enum?: unknown;
        enumName?: string;
        items?: { type?: unknown; enum?: unknown };
      };
      queue.push(...modelsOf(property.type), ...modelsOf(property.items?.type));
      if (property.enumName) {
        // For enum arrays Swagger moves the values into `items`.
        const values = JSON.stringify(enumValues(property.enum ?? property.items?.enum).sort());
        enums.set(property.enumName, (enums.get(property.enumName) ?? new Set()).add(values));
      }
    }
  }
  return [
    ...[...owners]
      .filter(([, models]) => models.size > 1)
      .map(
        ([name, models]) =>
          `schema name "${name}" is used by ${models.size} different classes; rename one or add @ApiSchema({ name })`,
      ),
    ...[...enums]
      .filter(([, variants]) => variants.size > 1)
      .map(
        ([name, variants]) =>
          `enumName "${name}" has different values in different places: ${[...variants].join(' vs ')}`,
      ),
  ];
}

/** Values of a TS enum, an array or a lazy enum (`() => Enum`), as Swagger reads them. */
function enumValues(source: unknown): string[] {
  if (typeof source === 'function') return enumValues((source as () => unknown)());
  if (Array.isArray(source)) return source.map(String);
  if (!source || typeof source !== 'object') return [];
  const reverse = new Set(
    Object.values(source)
      .filter((v) => typeof v === 'number')
      .map(String),
  );
  return Object.entries(source)
    .filter(([key]) => !reverse.has(key))
    .map(([, value]) => String(value));
}

export function findContractViolations(document: OpenAPIObject, routes: RouteMetadata[]): string[] {
  const violations: string[] = [];
  const label = (route: RouteMetadata) => `${route.controller}.${route.handler}`;

  const owners = new Map<string, string[]>();
  for (const route of routes) {
    if (!route.operationId) {
      violations.push(`${label(route)}: missing operationId (@ApiOperation({ summary, operationId }))`);
      continue;
    }
    if (!CAMEL_CASE.test(route.operationId)) {
      violations.push(`${label(route)}: operationId "${route.operationId}" is not camelCase`);
    }
    owners.set(route.operationId, [...(owners.get(route.operationId) ?? []), label(route)]);
  }
  for (const [operationId, labels] of owners) {
    if (labels.length > 1) violations.push(`operationId "${operationId}" is used by ${labels.join(', ')}`);
  }

  const byOperationId = new Map(routes.map((route) => [route.operationId, route]));
  let documented = 0;
  const schemaSeen = new Set<string>();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      documented += 1;
      const route = operation.operationId ? byOperationId.get(operation.operationId) : undefined;
      const where = `${method.toUpperCase()} ${path}`;
      // No match: the route has no explicit operationId (Swagger generated one); reported above.
      if (!route) continue;
      for (const problem of operationProblems(route, operation, document)) {
        // A shared component (`#Name...`) with a problem is reported once, not once per route using it.
        const key = problem.startsWith('#') ? problem : `${where}:${problem}`;
        if (schemaSeen.has(key)) continue;
        schemaSeen.add(key);
        violations.push(`${where} (${label(route)}): ${problem}`);
      }
    }
  }
  violations.push(...findSchemaNameCollisions(routes));
  if (documented !== routes.length) {
    violations.push(`the document has ${documented} operations but the app has ${routes.length} routes`);
  }
  return violations;
}
