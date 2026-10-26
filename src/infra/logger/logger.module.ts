import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { appConfig, loggerConfig } from '@/config/configuration';
import { RequestContext } from '@/common/context/request-context';

const QUIET_PATHS = /\/(health|ready)$/;

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  '*.password',
  '*.otp',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
];

/**
 * Structured JSON logs (pretty in dev). Every HTTP request is logged once on completion
 * with method, path, status, duration, requestId and userId.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [loggerConfig.KEY, appConfig.KEY],
      useFactory: (log: ConfigType<typeof loggerConfig>, app: ConfigType<typeof appConfig>) => ({
        pinoHttp: {
          level: log.level,
          base: { app: app.name, env: app.env, release: app.release },
          redact: { paths: REDACT, censor: '[redacted]' },
          // pino-pretty is a dev dependency: never load it in production images.
          transport:
            log.pretty && !app.isProduction
              ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' } }
              : undefined,
          genReqId: (req: IncomingMessage) =>
            (req as IncomingMessage & { id?: string }).id ?? RequestContext.requestId() ?? '',
          autoLogging: { ignore: (req: IncomingMessage) => QUIET_PATHS.test(req.url ?? '') },
          customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
            // 499: the client hung up first (HttpTraffic). Routine on mobile networks.
            if (res.statusCode === 499) return 'info';
            if (err || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            return 'info';
          },
          customProps: (req: IncomingMessage) => ({
            userId: (req as IncomingMessage & { user?: { id: string } }).user?.id,
          }),
          serializers: {
            req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url,
              ip: req.remoteAddress,
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
        },
      }),
    }),
  ],
})
export class LoggerModule {}
