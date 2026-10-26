import '@/bootstrap/openapi-env';
import { writeFileSync } from 'node:fs';
import { createOpenApiDocument, OpenApiBuild } from '@/bootstrap/openapi';
import { findContractViolations } from '@/common/swagger/openapi-contract';

type Schema = Record<string, unknown>;

/** Every schema name reachable from a node (follows `$ref`, properties, items, compositions). */
function reachableSchemas(schemas: Record<string, Schema>, root: unknown): Set<string> {
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const ref = (node as Schema).$ref;
    if (typeof ref === 'string') {
      const name = ref.split('/').pop()!;
      if (seen.has(name)) return;
      seen.add(name);
      visit(schemas[name]);
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(root);
  return seen;
}

/**
 * Builds the real OpenAPI document from the api root module (no database, no Redis) and fails
 * when any route breaks the documentation contract: missing or repeated operationId, no summary
 * or tags, wrong auth requirement, no 2xx schema, or `{}` / untyped object schemas.
 * Frontend clients and the Postman collection are generated from this document.
 */
describe('OpenAPI contract', () => {
  let build: OpenApiBuild;

  beforeAll(async () => {
    build = await createOpenApiDocument();
    if (process.env.OPENAPI_DUMP) writeFileSync(process.env.OPENAPI_DUMP, JSON.stringify(build.document, null, 2));
  }, 60_000);

  it('documents every route', () => {
    expect(build.routes.length).toBeGreaterThan(0);
    expect(build.routes.every((route) => route.operationId)).toBe(true);
  });

  it('meets the contract on every route', () => {
    expect(findContractViolations(build.document, build.routes)).toEqual([]);
  });

  it('never documents a secret in any response (hashes, tokens kept server side)', () => {
    const schemas = (build.document.components?.schemas ?? {}) as Record<string, Schema>;
    const secretFields = /^(password|passwordHash|codeHash|refreshTokenHash|secret|apiKey|token)$/;
    const leaks: string[] = [];
    for (const [path, item] of Object.entries(build.document.paths)) {
      for (const [method, operation] of Object.entries(item as Record<string, { responses?: unknown }>)) {
        for (const name of reachableSchemas(schemas, operation.responses)) {
          const props = Object.keys(schemas[name]?.properties ?? {});
          const found = props.filter((prop) => secretFields.test(prop));
          if (found.length) leaks.push(`${method.toUpperCase()} ${path}: ${name}.${found.join(', ')}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});
