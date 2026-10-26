import '@/common/time/force-utc';
import '@/bootstrap/openapi-env';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GraphqlAppModule } from '@/app/graphql.module';
import { buildSchemaSdl } from '@/infra/graphql/schema-export';

/**
 * Writes the GraphQL SDL (`schema.gql`, committed) from the resolvers, without a database or Redis.
 * The dev server rewrites the same file on start; this is for CI and for clients generating types.
 *
 *   pnpm graphql:schema [output path, default ./schema.gql]
 */
async function main(): Promise<void> {
  const output = resolve(process.argv[2] ?? 'schema.gql');
  writeFileSync(output, await buildSchemaSdl(GraphqlAppModule));
  console.log(`Wrote ${output}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
