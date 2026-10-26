import { INestApplicationContext, Logger as NestLogger, Type } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';
import { grpcServerOptions } from '@/infra/transport/grpc/grpc-server';
import { ApiModule } from '@/app/api.module';
import { GrpcAppModule } from '@/app/grpc.module';
import { GraphqlAppModule } from '@/app/graphql.module';
import { SocketModule } from '@/app/socket.module';
import { appConfig, runtimeConfig } from '@/config/configuration';
import { RedisIoAdapter } from '@/infra/realtime/redis-io.adapter';
import { configureHttpApp } from './http-app';
import { handleFatalError, setFatalShutdown } from './process-handlers';
import { GracefulShutdown } from './shutdown';

export { registerProcessHandlers } from './process-handlers';

const logger = new NestLogger('Bootstrap');

/**
 * `abortOnError: false`: a boot failure is thrown (logged, sent to Sentry, exit 1) instead of
 * Nest's default `process.abort()`, which reports nothing. MongoDB and Redis being down is not a
 * boot failure: the process starts degraded and reconnects (docs/architecture/fault-tolerance.md).
 */
const factoryOptions = { bufferLogs: true, abortOnError: false } as const;

export async function createApiApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { ...factoryOptions, bodyParser: false });
  configureHttpApp(app);
  return app;
}

export async function createSocketApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(SocketModule, { ...factoryOptions, bodyParser: false });
  configureHttpApp(app);
  const adapter = new RedisIoAdapter(app);
  await adapter.connectToRedis();
  app.useWebSocketAdapter(adapter);
  return app;
}

export async function createGraphqlApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(GraphqlAppModule, {
    ...factoryOptions,
    bodyParser: false,
  });
  configureHttpApp(app);
  return app;
}

export async function startApi(): Promise<void> {
  const app = await createApiApp();
  installGracefulShutdown(app, 'API');
  const { apiPort, apiPrefix, defaultVersion, listenHost } = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  await app.listen(apiPort, listenHost);
  logger.log(`API listening on :${apiPort}/${apiPrefix}/v${defaultVersion}`);
}

export async function startSocket(): Promise<void> {
  const app = await createSocketApp();
  installGracefulShutdown(app, 'Socket');
  const { socketPort, listenHost } = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  await app.listen(socketPort, listenHost);
  logger.log(`Socket server listening on :${socketPort}`);
}

export async function startGraphql(): Promise<void> {
  const app = await createGraphqlApp();
  installGracefulShutdown(app, 'GraphQL');
  const { graphqlPort, listenHost } = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  await app.listen(graphqlPort, listenHost);
  logger.log(`GraphQL listening on :${graphqlPort}`);
}

/**
 * gRPC process: a Nest microservice on GRPC_PORT serving every service declared in proto/ that a
 * loaded module implements. No HTTP listener; liveness is the gRPC port itself plus the heartbeat.
 */
export async function createGrpcApp(port?: number): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(GrpcAppModule, { ...factoryOptions, bodyParser: false });
  app.useLogger(app.get(Logger));
  const { grpcPort, listenHost } = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  app.connectMicroservice<MicroserviceOptions>(grpcServerOptions(port ?? grpcPort, listenHost), {
    inheritAppConfig: true,
  });
  return app;
}

export async function startGrpc(): Promise<void> {
  const app = await createGrpcApp();
  installGracefulShutdown(app, 'gRPC');
  await app.startAllMicroservices();
  await app.init();
  const { grpcPort } = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  logger.log(`gRPC listening on :${grpcPort}`);
}

/** Worker and cron: DI container only, no HTTP server. */
export async function startContext(module: Type<unknown>, label: string): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(module, factoryOptions);
  app.useLogger(app.get(Logger));
  installGracefulShutdown(app, label);
  logger.log(`${label} started`);
  return app;
}

/** SIGTERM / SIGINT handling with the configured deadline; also the path a fatal error takes. */
export function installGracefulShutdown(app: INestApplicationContext, label: string): GracefulShutdown {
  const { shutdown } = app.get<ConfigType<typeof runtimeConfig>>(runtimeConfig.KEY);
  const graceful = new GracefulShutdown(app, {
    label,
    timeoutMs: shutdown.timeoutMs,
    drainDelayMs: shutdown.drainDelayMs,
  }).install();
  setFatalShutdown(graceful);
  return graceful;
}

/** Entry points: `startApi().catch(bootFailed)`. Logs, reports to Sentry, exits 1 (the platform restarts). */
export function bootFailed(error: unknown): void {
  NestLogger.flush();
  handleFatalError(error, 'bootFailure');
}
