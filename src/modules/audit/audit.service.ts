import { Injectable, Logger } from '@nestjs/common';
import { PaginatedResult } from '@/common/dto/pagination.dto';
import { LeanDoc } from '@/infra/database/base.repository';
import { AuditRepository } from './audit.repository';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';
import { AuditLog } from './schemas/audit-log.schema';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly repository: AuditRepository) {}

  /** Fire-and-forget: an audit write must never fail or slow the admin's request. */
  record(entry: Omit<AuditLog, 'createdAt'>): void {
    this.repository.create(entry).catch((err: unknown) => {
      this.logger.error({ err, action: entry.action, requestId: entry.requestId }, 'Failed to write audit log');
    });
  }

  search(query: AuditLogQueryDto): Promise<PaginatedResult<LeanDoc<AuditLog>>> {
    return this.repository.search(query);
  }
}
