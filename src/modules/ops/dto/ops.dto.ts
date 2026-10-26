import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { PaginationQueryDto } from '@/common/dto/pagination.dto';

const QUEUE_NAME = /^[a-z0-9-]{1,64}$/;
/** BullMQ ids: numeric (auto) or our deterministic ids (`note-reminder-<id>-<ms>`, `notify-<sha>`, …). */
const JOB_ID = /^[A-Za-z0-9._-]{1,200}$/;

export class QueueParamDto {
  @ApiProperty({ example: 'notes' })
  @Matches(QUEUE_NAME, { message: 'name must use lower-case letters, digits and dashes' })
  name: string;
}

export class FailedJobParamDto extends QueueParamDto {
  @ApiProperty({ example: 'account-deletion-6720f0c2a1b2c3d4e5f60789' })
  @Matches(JOB_ID, { message: 'jobId must use letters, digits, dots, dashes and underscores' })
  jobId: string;
}

export class OutboxEventParamDto {
  @ApiProperty({ example: '0b6c2f5e-6d1a-4b8f-9f0e-3a2b1c4d5e6f' })
  @Matches(/^[a-f0-9-]{36}$/, { message: 'Event must be the id shown in the parked events list.' })
  eventId: string;
}

/** `page` (1-based) and `limit` (≤ 100) over the failed list, newest failure first. */
export class FailedJobsQueryDto extends PaginationQueryDto {}
