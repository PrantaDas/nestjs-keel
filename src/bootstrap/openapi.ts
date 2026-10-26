import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ApiModule } from '@/app/api.module';
import { buildOpenApiDocument, collectRouteMetadata, RouteMetadata } from '@/common/swagger/openapi-document';

export interface OpenApiBuild {
  document: OpenAPIObject;
  /** Every route with its guard metadata (the contract test checks the document against it). */
  routes: RouteMetadata[];
}

export interface OpenApiExportOptions {
  apiPrefix?: string;
  version?: string;
}

/**
 * Builds the API's OpenAPI document without a database, Redis or a listening port: Nest's preview
 * mode scans modules and controllers but instantiates no providers. Import `./openapi-env` first
 * so the config schema is satisfied.
 */
export async function createOpenApiDocument({
  apiPrefix = process.env.API_PREFIX || 'api',
  version = process.env.API_DEFAULT_VERSION || '1',
}: OpenApiExportOptions = {}): Promise<OpenApiBuild> {
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
    preview: true,
    logger: false,
    abortOnError: false,
    bodyParser: false,
  });
  try {
    app.setGlobalPrefix(apiPrefix);
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: version });
    const title = process.env.APP_NAME || 'nest-boilerplate';
    return { document: buildOpenApiDocument(app, { version, title }), routes: collectRouteMetadata(app) };
  } finally {
    await app.close();
  }
}
