import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import type { Request, Response } from 'express';
import { AccessValidator } from '@/common/auth/access-validator';
import { TokenService } from '@/common/auth/token.service';
import { AuthErrors, AuthException } from '@/common/exceptions';
import { appConfig, graphqlConfig } from '@/config/configuration';
import { formatGraphqlError } from './graphql-errors';
import { GraphqlPubSubModule } from './graphql-pubsub';
import { complexityLimit, depthLimit } from './query-limits';
import { RequestLoaders } from './request-loaders';

/** What every resolver can read from `@Context()`. */
export interface GraphqlContext {
  req: Request;
  res?: Response;
  loaders: RequestLoaders;
}

/** The parts of a graphql-ws connection context this module reads and writes. */
interface WsConnection {
  connectionParams?: Record<string, unknown>;
  extra: unknown;
}

type WsExtra = { headers?: Record<string, string> };

/**
 * Code-first GraphQL on Apollo (docs/conventions/graphql.md):
 *  - the schema is generated from the resolvers in memory; the process never writes files (the
 *    image is read-only for its user). The committed `schema.gql` (sorted, so diffs stay readable)
 *    comes from `pnpm graphql:schema`, and a unit test fails when it is stale;
 *  - the same guards as REST (global JwtAuthGuard / RolesGuard handle the `graphql` context), the
 *    same ValidationPipe on `@Args` DTOs, and errors in the same contract (graphql-errors.ts);
 *  - depth and complexity limits, a fresh DataLoader registry per operation;
 *  - subscriptions over `graphql-ws`, authenticated with the same access token in
 *    `connectionParams.authorization`, fed by Redis pub/sub;
 *  - introspection follows GRAPHQL_INTROSPECTION (off in production by default); automatic
 *    persisted queries are on (Apollo's default), so production clients can send hashes only.
 */
@Module({
  imports: [
    GraphqlPubSubModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [graphqlConfig.KEY, appConfig.KEY, TokenService, AccessValidator],
      useFactory: (
        config: ConfigType<typeof graphqlConfig>,
        app: ConfigType<typeof appConfig>,
        tokens: TokenService,
        access: AccessValidator,
      ): ApolloDriverConfig => ({
        path: config.path,
        autoSchemaFile: true,
        sortSchema: true,
        introspection: config.introspection,
        graphiql: !app.isProduction && config.introspection,
        // Shutdown: keep answering while in-flight requests drain (GracefulShutdown runs before it).
        stopOnApplicationShutdown: true,
        // Guards and interceptors also run on @ResolveField, so field-level auth works.
        fieldResolverEnhancers: ['guards'],
        validationRules: [depthLimit(config.maxDepth)],
        plugins: [complexityLimit(config.maxComplexity)],
        formatError: formatGraphqlError,
        context: ({ req, res, extra }: { req?: Request; res?: Response; extra?: WsExtra }): GraphqlContext => ({
          // Over WebSocket there is no HTTP request: the guard reads the token the client sent at connect.
          req: req ?? ({ headers: extra?.headers ?? {} } as Request),
          res,
          loaders: new RequestLoaders(),
        }),
        subscriptions: {
          'graphql-ws': {
            path: config.path,
            /** Refuses the connection unless the token and its session are valid (same checks as REST). */
            onConnect: async (context: WsConnection) => {
              const raw = context.connectionParams?.authorization ?? context.connectionParams?.Authorization;
              const header = typeof raw === 'string' ? raw : '';
              const token = TokenService.extractBearer(header) ?? header;
              if (!token) throw new AuthException(AuthErrors.MISSING_BEARER_TOKEN);
              await access.validate(await tokens.verifyAccessToken(token));
              (context.extra as WsExtra).headers = { authorization: `Bearer ${token}` };
              return true;
            },
          },
        },
      }),
    }),
  ],
})
export class GraphqlServerModule {}
