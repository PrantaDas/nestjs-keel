import { Module } from '@nestjs/common';
import { HealthModule } from '@/infra/health/health.module';
import { HeartbeatModule } from '@/infra/heartbeat/heartbeat.module';
import { IdentityCoreModule } from '@/modules/identity/identity.module';
import { NotificationsCoreModule } from '@/modules/notifications/notifications.module';
import { CoreModule } from './core.module';
import { httpProviders } from './http-providers';

/** Socket.IO process. Serves only gateways plus /api/health and /api/ready over HTTP. */
@Module({
  imports: [
    CoreModule,
    HeartbeatModule.forProcess('socket'),
    HealthModule,
    // Handshake auth needs AccessValidator (identity).
    IdentityCoreModule,
    NotificationsCoreModule,
    // g:module socket (keep this marker: the generator adds new modules above it)
  ],
  providers: httpProviders,
})
export class SocketModule {}
