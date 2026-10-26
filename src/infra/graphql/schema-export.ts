import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GRAPHQL_SDL_FILE_HEADER, GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { lexicographicSortSchema, printSchema } from 'graphql';

const RESOLVER_TYPE_METADATA = 'graphql:resolver_type';

type ModuleRef = Type<unknown> | DynamicModule | Promise<DynamicModule> | undefined;

/**
 * Every resolver class reachable from a root module, read from the `@Module()` metadata alone: no
 * provider is instantiated, so no configuration, database or Redis is needed.
 */
export function collectResolvers(root: Type<unknown>): Type<unknown>[] {
  const resolvers = new Set<Type<unknown>>();
  const seen = new Set<unknown>();
  const visit = (ref: ModuleRef): void => {
    if (!ref || ref instanceof Promise || seen.has(ref)) return;
    seen.add(ref);
    const dynamic = typeof ref === 'object' ? ref : undefined;
    const type = dynamic ? dynamic.module : (ref as Type<unknown>);
    const read = (key: string) => (Reflect.getMetadata(key, type) ?? []) as unknown[];
    const providers = [...read('providers'), ...(dynamic?.providers ?? [])];
    for (const provider of providers) {
      if (typeof provider === 'function' && Reflect.getMetadata(RESOLVER_TYPE_METADATA, provider)) {
        resolvers.add(provider as Type<unknown>);
      }
    }
    for (const child of [...read('imports'), ...(dynamic?.imports ?? [])]) visit(child as ModuleRef);
  };
  visit(root);
  return [...resolvers];
}

/**
 * The SDL of the schema the graphql process builds (sorted, with the generated-file header). Used by `pnpm graphql:schema` and the test that fails when the committed file is stale.
 */
export async function buildSchemaSdl(rootModule: Type<unknown>): Promise<string> {
  const builder = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, { logger: false });
  try {
    const schema = await builder.get(GraphQLSchemaFactory).create(collectResolvers(rootModule));
    return GRAPHQL_SDL_FILE_HEADER + printSchema(lexicographicSortSchema(schema));
  } finally {
    await builder.close();
  }
}
