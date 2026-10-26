import { Module } from '@nestjs/common';
import { HealthModule } from '@/infra/health/health.module';
import { HeartbeatModule } from '@/infra/heartbeat/heartbeat.module';
import { CoreModule } from './core.module';
import { httpProviders } from './http-providers';

/** GraphQL process: `/graphql` over HTTP and `graphql-ws`, plus health. */
@Module({
  imports: [CoreModule, HeartbeatModule.forProcess('graphql'), HealthModule],
  providers: httpProviders,
})
export class GraphqlAppModule {}
