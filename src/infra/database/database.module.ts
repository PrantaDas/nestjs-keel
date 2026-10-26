import { Global, Logger, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import mongooseAggregatePaginate from 'mongoose-aggregate-paginate-v2';
import mongoosePaginate from 'mongoose-paginate-v2';
import { Clock } from '@/common/time/clock';
import { RateGate } from '@/common/utils/rate-gate';
import { mongoConfig, runtimeConfig } from '@/config/configuration';
import { MongoConnectionSupervisor, mongoConnectOptions } from './mongo-connection.supervisor';
import { TransactionService } from './transaction.service';

@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [mongoConfig.KEY, runtimeConfig.KEY, Clock],
      useFactory: (
        config: ConfigType<typeof mongoConfig>,
        resilience: ConfigType<typeof runtimeConfig>,
        clock: Clock,
      ) => ({
        uri: config.uri,
        ...mongoConnectOptions(config, resilience),
        // Never block the boot on MongoDB: MongoConnectionSupervisor waits a bounded time, then
        // keeps retrying in the background while the process serves (degraded) traffic.
        lazyConnection: true,
        connectionFactory: (connection: Connection) => {
          // Every model on this connection gets `paginate` and `aggregatePaginate`.
          connection.plugin(mongoosePaginate);
          connection.plugin(mongooseAggregatePaginate);
          // Schema `timestamps` (createdAt / updatedAt on save, updates and bulkWrite) read the
          // injected Clock, like all other time, so a test's frozen clock also freezes them.
          connection.base.now = () => clock.now();
          watchConnection(connection);
          return connection;
        },
      }),
    }),
  ],
  providers: [TransactionService, MongoConnectionSupervisor],
  exports: [TransactionService],
})
export class DatabaseModule {}

/**
 * Connection state logs. Attaching an `error` listener also marks the lazy first connection's
 * promise as handled (a failed boot connection is retried by MongoConnectionSupervisor, never an
 * unhandled rejection).
 */
function watchConnection(connection: Connection): void {
  const logger = new Logger('MongoDB');
  const errors = new RateGate(30_000);
  let disconnectedAt: number | undefined;

  connection.on('error', (err: unknown) => {
    const gate = errors.pass('error');
    if (gate.pass) logger.error({ err, suppressed: gate.suppressed }, 'MongoDB connection error');
  });
  connection.on('disconnected', () => {
    disconnectedAt ??= performance.now();
    logger.warn('MongoDB disconnected: queries wait up to the server selection timeout, then answer 503');
  });
  const restored = () => {
    if (disconnectedAt === undefined) return;
    logger.log({ downForMs: Math.round(performance.now() - disconnectedAt) }, 'MongoDB connection restored');
    disconnectedAt = undefined;
    errors.reset('error');
  };
  connection.on('reconnected', restored);
  connection.on('connected', restored);
}
