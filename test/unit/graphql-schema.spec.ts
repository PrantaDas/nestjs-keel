import '@/bootstrap/openapi-env';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GraphqlAppModule } from '@/app/graphql.module';
import { buildSchemaSdl } from '@/infra/graphql/schema-export';

/** The committed SDL is what clients generate types from: it must match the resolvers. */
describe('GraphQL schema', () => {
  it('schema.gql is up to date (run `pnpm graphql:schema`)', async () => {
    const committed = readFileSync(join(__dirname, '..', '..', 'schema.gql'), 'utf8');
    expect(await buildSchemaSdl(GraphqlAppModule)).toBe(committed);
  }, 60_000);
});
