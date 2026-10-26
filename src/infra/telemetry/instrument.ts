/* eslint-disable @typescript-eslint/no-require-imports */
import { basename } from 'node:path';
import { onTelemetryShutdown } from './telemetry';

/*
 * OpenTelemetry traces and metrics, off unless `OTEL_ENABLED=true` (one switch). Imported before
 * Sentry and before any instrumented library, so HTTP, Express, MongoDB, ioredis and gRPC are
 * patched as they load. Reads process.env directly: it runs before the Nest config module.
 * The SDK is required only when enabled, so processes without telemetry never load it.
 *
 * Exporters use OTLP over HTTP (`OTEL_EXPORTER_OTLP_ENDPOINT`, default http://localhost:4318); every
 * standard `OTEL_*` variable of the SDK applies. Sentry never registers a tracer provider of its own
 * (sentry/instrument.ts), so the two do not compete; Sentry keeps reporting errors.
 */
if (process.env.OTEL_ENABLED === 'true') {
  const { NodeSDK } = require('@opentelemetry/sdk-node') as typeof import('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } =
    require('@opentelemetry/auto-instrumentations-node') as typeof import('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } =
    require('@opentelemetry/exporter-trace-otlp-http') as typeof import('@opentelemetry/exporter-trace-otlp-http');
  const { OTLPMetricExporter } =
    require('@opentelemetry/exporter-metrics-otlp-http') as typeof import('@opentelemetry/exporter-metrics-otlp-http');
  const { PeriodicExportingMetricReader } =
    require('@opentelemetry/sdk-metrics') as typeof import('@opentelemetry/sdk-metrics');
  const { resourceFromAttributes } = require('@opentelemetry/resources') as typeof import('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } =
    require('@opentelemetry/semantic-conventions') as typeof import('@opentelemetry/semantic-conventions');

  // `main.api.js` → `api`: one service name per process kind, same image.
  const processKind = basename(process.argv[1] ?? 'app').replace(/^main\.|\.(js|ts)$/g, '');
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || `${process.env.APP_NAME || 'app'}-${processKind}`,
      [ATTR_SERVICE_VERSION]: process.env.RELEASE || 'dev',
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
    instrumentations: [
      getNodeAutoInstrumentations({
        // Noisy and low value: every fs call and DNS lookup as a span.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });
  sdk.start();
  onTelemetryShutdown(() => sdk.shutdown());
}
