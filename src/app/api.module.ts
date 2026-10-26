import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '@/common/auth/jwt-auth.guard';
import { RolesGuard } from '@/common/auth/roles.guard';
import { HealthModule } from '@/infra/health/health.module';
import { HeartbeatModule } from '@/infra/heartbeat/heartbeat.module';
import { AppThrottlerGuard } from '@/infra/security/app-throttler.guard';
import { SecurityModule } from '@/infra/security/security.module';
import { AuditModule } from '@/modules/audit/audit.module';
import { IdentityApiModule } from '@/modules/identity/identity.module';
import { NotificationsApiModule } from '@/modules/notifications/notifications.module';
import { CoreModule } from './core.module';
import { httpProviders } from './http-providers';

/** REST API process. Feature HTTP modules are added here (`pnpm g:module` does it for you). */
@Module({
  imports: [
    CoreModule,
    HeartbeatModule.forProcess('api'),
    SecurityModule,
    HealthModule,
    AuditModule,
    IdentityApiModule,
    NotificationsApiModule,
    // g:module api (keep this marker: the generator adds new modules above it)
  ],
  providers: [
    ...httpProviders,
    // Order matters: authenticate → authorise → rate limit (per user when known).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
  ],
})
export class ApiModule {}
