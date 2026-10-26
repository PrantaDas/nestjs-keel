import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { auditConfig } from '@/config/configuration';
import { AuditController } from './audit.controller';
import { AuditInterceptor } from './audit.interceptor';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';
import { AuditLog, AuditLogSchema } from './schemas/audit-log.schema';

const DAY_SECONDS = 24 * 60 * 60;

@Module({
  imports: [
    MongooseModule.forFeatureAsync([
      {
        name: AuditLog.name,
        inject: [auditConfig.KEY],
        useFactory: (config: ConfigType<typeof auditConfig>) => {
          const hasTtl = AuditLogSchema.indexes().some(([, options]) => options?.expireAfterSeconds !== undefined);
          if (!hasTtl) {
            AuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: config.retentionDays * DAY_SECONDS });
          }
          return AuditLogSchema;
        },
      },
    ]),
  ],
  controllers: [AuditController],
  providers: [AuditRepository, AuditService, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  exports: [AuditService],
})
export class AuditModule {}
