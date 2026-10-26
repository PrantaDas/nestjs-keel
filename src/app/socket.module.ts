import { Module } from '@nestjs/common';
import { HealthModule } from '@/infra/health/health.module';
import { HeartbeatModule } from '@/infra/heartbeat/heartbeat.module';
import { CoreModule } from './core.module';
import { httpProviders } from './http-providers';

/** Socket.IO process. Serves only gateways plus /api/health and /api/ready over HTTP. */
@Module({
  imports: [CoreModule, HeartbeatModule.forProcess('socket'), HealthModule],
  providers: httpProviders,
})
export class SocketModule {}
