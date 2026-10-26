import { Module } from '@nestjs/common';
import { HeartbeatModule } from '@/infra/heartbeat/heartbeat.module';
import { NotesRpcModule } from '@/modules/examples/notes.module';
import { IdentityCoreModule } from '@/modules/identity/identity.module';
import { NotificationsCoreModule } from '@/modules/notifications/notifications.module';
import { CoreModule } from './core.module';

/**
 * gRPC process (optional): serves the ports of modules extracted (or about to be) to other services,
 * from proto/. Same image, `node dist/main.grpc.js`. In the monolith nothing calls it unless
 * TRANSPORT_ROUTES sends a port over gRPC (docs/architecture/microservices.md).
 */
@Module({
  imports: [
    CoreModule,
    HeartbeatModule.forProcess('grpc'),
    IdentityCoreModule,
    NotificationsCoreModule,
    NotesRpcModule,
    // g:module grpc (keep this marker: the generator adds new modules above it)
  ],
})
export class GrpcAppModule {}
