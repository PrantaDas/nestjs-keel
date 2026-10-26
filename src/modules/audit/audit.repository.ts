import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import { PaginatedResult } from '@/common/dto/pagination.dto';
import { BaseRepository, LeanDoc } from '@/infra/database/base.repository';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';
import { AuditLog } from './schemas/audit-log.schema';

@Injectable()
export class AuditRepository extends BaseRepository<AuditLog> {
  constructor(@InjectModel(AuditLog.name) model: Model<AuditLog>) {
    super(model);
  }

  search(query: AuditLogQueryDto): Promise<PaginatedResult<LeanDoc<AuditLog>>> {
    const filter: QueryFilter<AuditLog> = {};
    if (query.actorId) filter.actorId = query.actorId;
    if (query.action) filter.action = query.action;
    if (query.resource) filter.resource = query.resource;
    if (query.resourceId) filter.resourceId = query.resourceId;
    if (query.from || query.to) {
      filter.createdAt = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lt: query.to } : {}),
      };
    }
    return this.paginate(filter, { page: query.page, limit: query.limit, sort: { createdAt: -1 } });
  }
}
