import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '@/common/auth/auth.decorators';
import { Permission } from '@/common/auth/permissions';
import { ResponseMessage } from '@/common/decorators/response.decorators';
import { ApiEnvelope, ApiEnvelopeArray, ApiNoContent, ApiPaginated, ApiStandardErrors } from '@/common/swagger';
import { Audit } from '@/common/decorators/audit.decorator';
import { FailedJobParamDto, FailedJobsQueryDto, OutboxEventParamDto, QueueParamDto } from './dto/ops.dto';
import {
  OpsOutboxEventResponse,
  OpsOutboxRetriedResponse,
  OpsFailedJobResponse,
  OpsProcessResponse,
  OpsQueueOverviewResponse,
  OpsRetriedJobResponse,
} from './dto/ops.responses';
import { OpsErrors } from './ops.errors';
import { OpsService } from './ops.service';

@ApiTags('Admin · Ops')
@ApiBearerAuth()
@RequirePermissions(Permission.OPS_READ)
@Controller('admin/ops/queues')
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get()
  @ApiOperation({
    summary: 'Background queues: waiting, active, delayed and failed jobs, completed / failed in the last 24 h',
    description: 'One entry per BullMQ queue (purpose and owning module from the queue policy table).',
    operationId: 'adminOpsQueuesList',
  })
  @ApiEnvelopeArray(OpsQueueOverviewResponse)
  @ResponseMessage('Background task status loaded.')
  overview() {
    return this.ops.overview();
  }

  @Get(':name/failed')
  @ApiOperation({
    summary: 'Failed jobs of a queue, newest first (id, name, attempts, reason, timestamps; never the payload)',
    operationId: 'adminOpsFailedJobsList',
  })
  @ApiPaginated(OpsFailedJobResponse)
  @ApiStandardErrors(OpsErrors.OPS_QUEUE_NOT_FOUND)
  @ResponseMessage('Failed jobs loaded.')
  failed(@Param() params: QueueParamDto, @Query() query: FailedJobsQueryDto) {
    return this.ops.failed(params.name, query);
  }

  @Post(':name/failed/:jobId/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.OPS_READ, Permission.OPS_WRITE)
  @Audit({ action: 'ops.failed-job.retry', resource: 'queue-job', resourceIdParam: 'jobId' })
  @ApiOperation({
    summary: 'Retry a failed job with a fresh attempt budget (super admin; audited)',
    description:
      'Side effects stay single: sends are claimed, so a job whose message already went out (or whose outcome ' +
      'is unknown) does not send again. 409 when the job left the failed list meanwhile.',
    operationId: 'adminOpsFailedJobsRetry',
  })
  @ApiEnvelope(OpsRetriedJobResponse)
  @ApiStandardErrors(OpsErrors.OPS_QUEUE_NOT_FOUND, OpsErrors.OPS_JOB_NOT_FOUND, OpsErrors.OPS_JOB_NOT_FAILED)
  @ResponseMessage('Retry started.')
  retry(@Param() params: FailedJobParamDto) {
    return this.ops.retry(params.name, params.jobId);
  }

  @Delete(':name/failed/:jobId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(Permission.OPS_READ, Permission.OPS_WRITE)
  @Audit({ action: 'ops.failed-job.discard', resource: 'queue-job', resourceIdParam: 'jobId' })
  @ApiOperation({ summary: 'Discard a failed job (super admin; audited)', operationId: 'adminOpsFailedJobsDiscard' })
  @ApiNoContent()
  @ApiStandardErrors(OpsErrors.OPS_QUEUE_NOT_FOUND, OpsErrors.OPS_JOB_NOT_FOUND, OpsErrors.OPS_JOB_NOT_FAILED)
  discard(@Param() params: FailedJobParamDto) {
    return this.ops.discard(params.name, params.jobId);
  }
}

@ApiTags('Admin · Ops')
@ApiBearerAuth()
@RequirePermissions(Permission.OPS_READ)
@Controller('admin/ops/outbox')
export class OpsOutboxController {
  constructor(private readonly ops: OpsService) {}

  @Get('failed')
  @ApiOperation({
    summary: 'Domain events parked after too many failed deliveries (never the payload)',
    operationId: 'adminOpsOutboxFailedList',
  })
  @ApiPaginated(OpsOutboxEventResponse)
  @ResponseMessage('Parked events loaded.')
  failed(@Query() query: FailedJobsQueryDto) {
    return this.ops.failedEvents(query);
  }

  @Post(':eventId/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.OPS_READ, Permission.OPS_WRITE)
  @Audit({ action: 'ops.outbox-event.retry', resource: 'outbox-event', resourceIdParam: 'eventId' })
  @ApiOperation({ summary: 'Deliver a parked event again (super admin; audited)', operationId: 'adminOpsOutboxRetry' })
  @ApiEnvelope(OpsOutboxRetriedResponse)
  @ApiStandardErrors(OpsErrors.OPS_EVENT_NOT_FOUND)
  @ResponseMessage('Event queued for delivery again.')
  retry(@Param() params: OutboxEventParamDto) {
    return this.ops.retryEvent(params.eventId);
  }
}

@ApiTags('Admin · Ops')
@ApiBearerAuth()
@RequirePermissions(Permission.OPS_READ)
@Controller('admin/ops/processes')
export class OpsProcessesController {
  constructor(private readonly ops: OpsService) {}

  @Get()
  @ApiOperation({
    summary: 'Running processes (api, graphql, socket, worker, cron, grpc) from their heartbeats',
    description:
      'Each process writes a heartbeat every 30 s and drops off about 95 s after its last one, so a crashed ' +
      'or disconnected worker or cron process disappears from this list. Used by the smoke test.',
    operationId: 'adminOpsProcessesList',
  })
  @ApiEnvelopeArray(OpsProcessResponse)
  @ResponseMessage('Running processes loaded.')
  processes() {
    return this.ops.processes();
  }
}
