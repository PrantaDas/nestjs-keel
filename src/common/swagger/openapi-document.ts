import { HttpStatus, INestApplication, RequestMethod, Type } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import {
  DECORATORS,
  DocumentBuilder,
  ExampleObject,
  getSchemaPath,
  OpenAPIObject,
  OperationObject,
  ResponseObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { API_KEY_AUTH_KEY, IS_PUBLIC_KEY, PERMISSIONS_KEY, ROLES_KEY } from '@/common/auth/auth.decorators';
import { AccessErrors } from '@/common/auth/auth-access.errors';
import { Role } from '@/common/auth/auth.types';
import type { Permission } from '@/common/auth/permissions';
import { AuthErrors, RequestErrors } from '@/common/exceptions/error-codes';
import type { ErrorDefinition } from '@/common/exceptions/error-registry';
import { ParseObjectIdPipe } from '@/common/pipes/parse-object-id.pipe';
import { SUCCESS_STATUS_PLACEHOLDER } from './api-response.decorators';
import { ENVELOPE_MODELS, ErrorEnvelopeModel } from './envelope.models';
import { describeErrorExamples, errorExamples } from './error-examples';

/** What the guards and Nest know about one route, keyed by its `operationId`. */
export interface RouteMetadata {
  controller: string;
  handler: string;
  /** The controller class and handler function, for checks that read more metadata. */
  target: { controller: Type<unknown>; handler: object };
  operationId?: string;
  requestMethod: RequestMethod;
  successStatus: number;
  isPublic: boolean;
  roles: Role[];
  permissions: Permission[];
  /** `@ApiKeyAuth()`: machine clients send `x-api-key` instead of a bearer token. */
  apiKey: boolean;
  skipThrottle: boolean;
  parsesObjectId: boolean;
}

const THROTTLER_SKIP_DEFAULT = 'THROTTLER:SKIPdefault';

function override<T>(key: string, handler: object, controller: object): T | undefined {
  return (
    (Reflect.getMetadata(key, handler) as T | undefined) ?? (Reflect.getMetadata(key, controller) as T | undefined)
  );
}

/** Every HTTP route of the application with the metadata its guards read. */
export function collectRouteMetadata(app: INestApplication): RouteMetadata[] {
  const scanner = new MetadataScanner();
  const controllers = new Set<Type<unknown>>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      if (wrapper.metatype) controllers.add(wrapper.metatype as Type<unknown>);
    }
  }

  const routes: RouteMetadata[] = [];
  for (const controller of controllers) {
    const excluded = Reflect.getMetadata(DECORATORS.API_EXCLUDE_CONTROLLER, controller) as boolean[] | undefined;
    if (excluded?.[0]) continue;
    const prototype = controller.prototype as Record<string, object>;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name];
      if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;

      const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {}) as Record<
        string,
        { pipes?: unknown[] }
      >;
      const operation = Reflect.getMetadata(DECORATORS.API_OPERATION, handler) as OperationObject | undefined;

      const versions = routeVersions(handler, controller);
      const latest = versions.length ? Math.max(...versions.map(Number)) : undefined;
      for (const version of versions.length ? versions : [undefined]) {
        routes.push({
          controller: controller.name,
          handler: name,
          target: { controller, handler },
          operationId: versionedOperationId(operation?.operationId, version, latest),
          requestMethod,
          successStatus:
            (Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined) ??
            (requestMethod === RequestMethod.POST ? HttpStatus.CREATED : HttpStatus.OK),
          isPublic: override<boolean>(IS_PUBLIC_KEY, handler, controller) ?? false,
          roles: override<Role[]>(ROLES_KEY, handler, controller) ?? [],
          permissions: override<Permission[]>(PERMISSIONS_KEY, handler, controller) ?? [],
          apiKey: override<boolean>(API_KEY_AUTH_KEY, handler, controller) ?? false,
          skipThrottle: override<boolean>(THROTTLER_SKIP_DEFAULT, handler, controller) ?? false,
          parsesObjectId: Object.values(args).some(({ pipes = [] }) =>
            pipes.some((pipe) => pipe === ParseObjectIdPipe || pipe instanceof ParseObjectIdPipe),
          ),
        });
      }
    }
  }
  return routes;
}

/** The URI versions a route answers on (several when the controller lists them, e.g. `['1', '2']`). */
function routeVersions(handler: object, controller: object): string[] {
  const value = (Reflect.getMetadata(VERSION_METADATA, handler) ??
    Reflect.getMetadata(VERSION_METADATA, controller)) as string | string[] | undefined;
  return Array.isArray(value) && value.length > 1 ? value : [];
}

/**
 * A handler served on several versions appears once per version in the document; operation ids
 * must stay unique for generated clients, so every version but the latest gets a suffix:
 * `notesCreate` (v2) and `notesCreateV1` (v1).
 */
export function versionedOperationId(id: string | undefined, version: string | undefined, latest: number | undefined) {
  if (!id || version === undefined || Number(version) === latest) return id;
  return `${id}V${version}`;
}

/** Errors any route can return because of the global guards, pipes and body parsers. */
function sharedErrors(route: RouteMetadata, operation: OperationObject): ErrorDefinition[] {
  const errors: ErrorDefinition[] = [];
  const hasInput = Boolean(operation.requestBody) || (operation.parameters?.length ?? 0) > 0;
  if (hasInput) errors.push(RequestErrors.VALIDATION_FAILED);
  if (operation.requestBody) errors.push(RequestErrors.MALFORMED_JSON);
  if (route.parsesObjectId) errors.push(RequestErrors.INVALID_ID);

  if (route.apiKey) {
    errors.push(AccessErrors.INVALID_API_KEY);
  } else if (!route.isPublic) {
    errors.push(
      AuthErrors.MISSING_BEARER_TOKEN,
      AuthErrors.INVALID_TOKEN,
      AuthErrors.TOKEN_EXPIRED,
      AccessErrors.SESSION_REVOKED,
      AccessErrors.ACCOUNT_DISABLED,
    );
    if (route.roles.length || route.permissions.length) errors.push(AuthErrors.FORBIDDEN);
  }
  if (!route.skipThrottle) errors.push(RequestErrors.RATE_LIMITED);
  return errors;
}

const errorCodeOf = (example: unknown): number => (example as { value?: { errorCode?: number } }).value?.errorCode ?? 0;

function addErrors(operation: OperationObject, errors: ErrorDefinition[]): void {
  const responses = operation.responses as Record<string, ResponseObject>;
  for (const error of errors) {
    const key = String(error.status);
    const response = (responses[key] ??= { description: '' });
    const media = ((response.content ??= {})['application/json'] ??= {
      schema: { $ref: getSchemaPath(ErrorEnvelopeModel) },
    });
    const examples = { ...media.examples, ...errorExamples([error]) };
    media.examples = Object.fromEntries(
      Object.entries(examples).sort(([, a], [, b]) => errorCodeOf(a) - errorCodeOf(b)),
    );
    response.description = describeErrorExamples(media.examples);
  }
}

function sortResponses(operation: OperationObject): void {
  operation.responses = Object.fromEntries(
    Object.entries(operation.responses).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })),
  );
}

/**
 * Makes the generated document match runtime behaviour exactly:
 * - the `2XX` placeholder becomes the route's real success status;
 * - the errors shared by every route (validation, auth, roles, rate limit) are added from
 *   the guard metadata, merged with the domain errors the route declared via `@ApiStandardErrors`.
 */
export function finalizeOpenApiDocument(document: OpenAPIObject, routes: RouteMetadata[]): OpenAPIObject {
  renameMultiVersionOperations(document);
  const byOperationId = new Map(routes.filter((r) => r.operationId).map((r) => [r.operationId!, r]));

  for (const pathItem of Object.values(document.paths)) {
    for (const method of ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const) {
      const operation = pathItem[method];
      if (!operation) continue;
      const route = operation.operationId ? byOperationId.get(operation.operationId) : undefined;
      if (!route) continue;

      const responses = operation.responses as Record<string, ResponseObject>;
      const success = responses[SUCCESS_STATUS_PLACEHOLDER];
      if (success) {
        delete responses[SUCCESS_STATUS_PLACEHOLDER];
        responses[String(route.successStatus)] = success;
      }

      addErrors(operation, sharedErrors(route, operation));
      sortResponses(operation);
    }
  }
  return hoistErrorExamples(document);
}

/** Same rule as `versionedOperationId`, applied to the operations Swagger generated per version path. */
function renameMultiVersionOperations(document: OpenAPIObject): void {
  const byId = new Map<string, Array<{ operation: OperationObject; version: number }>>();
  for (const [path, item] of Object.entries(document.paths)) {
    const version = Number(/\/v(\d+)\//.exec(`${path}/`)?.[1] ?? NaN);
    for (const method of ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const) {
      const operation = item[method];
      if (!operation?.operationId || Number.isNaN(version)) continue;
      byId.set(operation.operationId, [...(byId.get(operation.operationId) ?? []), { operation, version }]);
    }
  }
  for (const [id, entries] of byId) {
    if (entries.length < 2) continue;
    const latest = Math.max(...entries.map((entry) => entry.version));
    for (const { operation, version } of entries) {
      operation.operationId = versionedOperationId(id, String(version), latest);
    }
  }
}

/**
 * Every error example is the same envelope wherever it appears: keep one copy per code in
 * `components.examples` and reference it, instead of repeating it on ~400 operations.
 */
function hoistErrorExamples(document: OpenAPIObject): OpenAPIObject {
  const shared: Record<string, ExampleObject> = {};
  for (const pathItem of Object.values(document.paths)) {
    for (const method of ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const) {
      for (const [status, response] of Object.entries(pathItem[method]?.responses ?? {})) {
        const media = Number(status) >= 400 ? (response as ResponseObject).content?.['application/json'] : undefined;
        if (!media?.examples) continue;
        for (const [key, example] of Object.entries(media.examples)) {
          if ('$ref' in example || !errorCodeOf(example)) continue;
          shared[key] = example;
          media.examples[key] = { $ref: `#/components/examples/${key}` };
        }
      }
    }
  }
  const sorted = Object.entries(shared).sort(([, a], [, b]) => errorCodeOf(a) - errorCodeOf(b));
  document.components = {
    ...document.components,
    examples: { ...document.components?.examples, ...Object.fromEntries(sorted) },
  };
  return document;
}

export interface OpenApiDocumentOptions {
  /** API version shown in the document (`1`). */
  version: string;
  /** Document title (defaults to the app name). */
  title?: string;
}

/**
 * The OpenAPI document of an HTTP app (global prefix and versioning must already be applied).
 * Used by Swagger UI, `pnpm openapi:export` and the contract test, so all three agree.
 */
export function buildOpenApiDocument(
  app: INestApplication,
  { version, title = 'API' }: OpenApiDocumentOptions,
): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle(title)
    .setDescription(
      [
        'Every 2xx JSON response is `{ success: true, message, data }` (plus `meta` when paginated);',
        'every error is `{ success: false, errorCode, error, errorMessage, details?, requestId }`.',
        'Instants are ISO-8601 UTC strings; day keys are `YYYY-MM-DD` business days (`BUSINESS_TIMEZONE`).',
        'Machine clients send `x-api-key` on the routes that say so.',
        'Send `X-Timezone: <IANA zone>` on every request; every response carries `x-server-time`.',
      ].join(' '),
    )
    .setVersion(`v${version}`)
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'apiKey')
    .build();

  const document = SwaggerModule.createDocument(app, config, { extraModels: ENVELOPE_MODELS });
  return finalizeOpenApiDocument(document, collectRouteMetadata(app));
}
