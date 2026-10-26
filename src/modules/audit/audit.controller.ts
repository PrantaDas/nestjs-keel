import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '@/common/auth/auth.decorators';
import { Permission } from '@/common/auth/permissions';
import { ResponseMessage } from '@/common/decorators/response.decorators';
import { ApiPaginated } from '@/common/swagger';
import { AuditService } from './audit.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';
import { AuditLogResponse } from './dto/audit-log.responses';

@ApiTags('Admin · Audit logs')
@ApiBearerAuth()
@RequirePermissions(Permission.AUDIT_READ)
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({
    summary: 'Search the staff audit trail (kept for AUDIT_RETENTION_DAYS)',
    operationId: 'adminAuditLogsList',
  })
  @ApiPaginated(AuditLogResponse)
  @ResponseMessage('Activity log loaded.')
  search(@Query() query: AuditLogQueryDto) {
    return this.audit.search(query);
  }
}
