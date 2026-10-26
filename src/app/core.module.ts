import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SentryModule } from '@sentry/nestjs/setup';
import { AuthCoreModule } from '@/common/auth/auth-core.module';
import { TimeModule } from '@/common/time/time.module';
import { AppConfigModule } from '@/config/config.module';
import { CacheModule } from '@/infra/cache/cache.module';
import { EventsModule } from '@/infra/events/events.module';
import { GraphqlPubSubModule } from '@/infra/graphql/graphql-pubsub';
import { CronInfraModule } from '@/infra/cron/cron-runs';
import { DatabaseModule } from '@/infra/database/database.module';
import { LifecycleModule } from '@/infra/lifecycle/lifecycle.module';
import { LoggerModule } from '@/infra/logger/logger.module';
import { QueueModule } from '@/infra/queue/queue.module';
import { RealtimeModule } from '@/infra/realtime/realtime.module';
import { RedisModule } from '@/infra/redis/redis.module';
import { IntegrationsModule } from '@/integrations/integrations.module';

/** Infrastructure shared by every process (api, graphql, socket, worker, cron). */
@Module({
  imports: [
    AppConfigModule,
    TimeModule,
    // In-process domain events; handlers enqueue jobs or do cheap work, never block.
    EventEmitterModule.forRoot({ wildcard: false, ignoreErrors: false }),
    LoggerModule,
    SentryModule.forRoot(),
    // Shutdown state (readiness, HTTP drain) and steps: workers stop, cron runs finish.
    LifecycleModule,
    CronInfraModule,
    DatabaseModule,
    RedisModule,
    CacheModule,
    QueueModule,
    RealtimeModule,
    // Domain events: every process writes to the outbox; only the worker relays (OutboxRelayModule).
    EventsModule,
    // Any process may publish GraphQL subscription events; only the graphql process serves them.
    GraphqlPubSubModule,
    AuthCoreModule,
    IntegrationsModule,
  ],
})
export class CoreModule {}
