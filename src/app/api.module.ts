import { Module } from '@nestjs/common';
import { HealthModule } from '@/infra/health/health.module';
import { HeartbeatModule } from '@/infra/heartbeat/heartbeat.module';
import { SecurityModule } from '@/infra/security/security.module';
import { CoreModule } from './core.module';
import { httpProviders } from './http-providers';

/** REST API process. Feature HTTP modules are added here. */
@Module({
  imports: [CoreModule, HeartbeatModule.forProcess('api'), SecurityModule, HealthModule],
  providers: [...httpProviders],
})
export class ApiModule {}
