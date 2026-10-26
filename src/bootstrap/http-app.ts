import { VersioningType } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import { raw } from 'express';
import helmet from 'helmet';
import type { Server } from 'node:http';
import { Logger } from 'nestjs-pino';
import { appConfig, runtimeConfig } from '@/config/configuration';
import { RequestContext } from '@/common/context/request-context';
import { bodyParserErrorMiddleware } from '@/common/filters/body-parser-error.middleware';
import { sanitizeInputMiddleware } from '@/common/security/sanitize-input.middleware';
import { buildOpenApiDocument } from '@/common/swagger/openapi-document';
import { HttpTraffic } from './http-traffic';

const traffic = new WeakMap<NestExpressApplication, HttpTraffic>();

/** Routes (below the global prefix) that receive the raw request body: signature-verified webhooks. */
export const RAW_BODY_ROUTES = ['/webhooks/stripe'];

/** The request tracker of an app configured by `configureHttpApp` (used by the shutdown drain). */
export function httpTrafficOf(app: unknown): HttpTraffic | undefined {
  return traffic.get(app as NestExpressApplication);
}

/**
 * HTTP hardening and conventions shared by the api and socket processes (and e2e tests).
 * Routes end up as `/api/v1/...`; health and webhooks are version-neutral (`/api/health`).
 *
 * Body limits by route type: JSON and urlencoded bodies `BODY_LIMIT` (1 MB); webhooks keep their raw
 * bytes (`RAW_BODY_ROUTES`, 1 MB); multipart uploads per route in their multer `limits` (files go
 * to S3 with presigned URLs instead); socket messages `SOCKET_MAX_BUFFER_BYTES`. Timeouts: see
 * `HttpTraffic` (per request) and `applyServerTimeouts` (per connection).
 */
export function configureHttpApp(app: NestExpressApplication): ConfigType<typeof appConfig> {
  const config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  const resilience = app.get<ConfigType<typeof runtimeConfig>>(runtimeConfig.KEY);

  app.useLogger(app.get(Logger));
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // First: request timeout, in-flight tracking for the shutdown drain, client aborts.
  const tracker = new HttpTraffic(resilience.http);
  traffic.set(app, tracker);
  app.use(tracker.middleware);
  applyServerTimeouts(app.getHttpServer(), resilience.http);

  app.use(RequestContext.middleware);
  app.use(helmet({ contentSecurityPolicy: config.swaggerEnabled ? false : undefined }));
  app.use(compression({ threshold: 1024 }));
  app.enableCors({
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    credentials: true,
    exposedHeaders: ['x-request-id', 'x-server-time', 'Content-Disposition', 'Retry-After'],
  });
  // Signature-verified webhooks must see the exact bytes the provider signed: re-serialised JSON
  // would not match. `raw` runs first and marks the body as parsed, so the JSON parser skips it and
  // the handler receives a Buffer (`req.body`). Only these paths; everything else is parsed as usual.
  for (const path of RAW_BODY_ROUTES) {
    app.use(`/${config.apiPrefix}${path}`, raw({ type: () => true, limit: '1mb' }));
  }
  app.useBodyParser('json', { limit: config.bodyLimit });
  app.useBodyParser('urlencoded', { limit: config.bodyLimit, extended: true, parameterLimit: 1000 });
  app.use(bodyParserErrorMiddleware);
  // After parsing: drops `$`-operators and dotted keys from bodies and query strings (NoSQL injection).
  app.use(sanitizeInputMiddleware);

  app.setGlobalPrefix(config.apiPrefix);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: config.defaultVersion });
  // Shutdown signals are handled by `GracefulShutdown` (src/bootstrap/shutdown.ts), not Nest's hooks.

  if (config.swaggerEnabled) setupSwagger(app, config);
  return config;
}

/**
 * Connection-level limits of the Node HTTP server:
 * - keep-alive outlives the load balancer's idle timeout (else it reuses a socket we closed: 502);
 * - headers must arrive within the keep-alive + 1 s (slowloris), the whole request (body included)
 *   within the upload timeout.
 */
export function applyServerTimeouts(server: Server, http: ConfigType<typeof runtimeConfig>['http']): void {
  server.keepAliveTimeout = http.keepAliveTimeoutMs;
  server.headersTimeout = http.keepAliveTimeoutMs + 1000;
  server.requestTimeout = Math.max(http.uploadRequestTimeoutMs + 5000, server.headersTimeout + 1000);
}

function setupSwagger(app: NestExpressApplication, config: ConfigType<typeof appConfig>): void {
  const document = buildOpenApiDocument(app, { version: config.defaultVersion, title: config.name });
  SwaggerModule.setup(`${config.apiPrefix}/docs`, app, document, { jsonDocumentUrl: `${config.apiPrefix}/docs-json` });
}
