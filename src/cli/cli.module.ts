import { Module } from '@nestjs/common';
import { CoreModule } from '@/app/core.module';
import { IdentityCoreModule } from '@/modules/identity/identity.module';
import { NotificationsCoreModule } from '@/modules/notifications/notifications.module';

/**
 * What command-line tools need: the shared infrastructure and the feature services they call
 * (no HTTP, no workers, no crons). The seed adds its own feature modules on top.
 */
@Module({
  imports: [CoreModule, IdentityCoreModule, NotificationsCoreModule],
})
export class CliModule {}
