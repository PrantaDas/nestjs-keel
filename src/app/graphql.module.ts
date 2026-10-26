import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '@/common/auth/jwt-auth.guard';
import { RolesGuard } from '@/common/auth/roles.guard';
import { GraphqlServerModule } from '@/infra/graphql/graphql.module';
import { HealthModule } from '@/infra/health/health.module';
import { HeartbeatModule } from '@/infra/heartbeat/heartbeat.module';
import { AppThrottlerGuard } from '@/infra/security/app-throttler.guard';
import { SecurityModule } from '@/infra/security/security.module';
import { NotesGraphqlModule } from '@/modules/examples/notes.module';
import { IdentityCoreModule } from '@/modules/identity/identity.module';
import { NotificationsCoreModule } from '@/modules/notifications/notifications.module';
import { CoreModule } from './core.module';
import { httpProviders } from './http-providers';

/**
 * GraphQL process: `/graphql` over HTTP and `graphql-ws`, plus health. Separate from the REST
 * process so its load (and its failure modes) are isolated; same guards, pipes and error contract.
 */
@Module({
  imports: [
    CoreModule,
    HeartbeatModule.forProcess('graphql'),
    SecurityModule,
    HealthModule,
    IdentityCoreModule,
    NotificationsCoreModule,
    GraphqlServerModule,
    NotesGraphqlModule,
    // g:module graphql (keep this marker: the generator adds new modules above it)
  ],
  providers: [
    ...httpProviders,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
  ],
})
export class GraphqlAppModule {}
