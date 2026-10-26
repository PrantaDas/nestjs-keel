import { ApiProperty } from '@nestjs/swagger';
import { ApiDateTimeProperty } from '@/common/swagger';
import { QueueName } from '@/infra/queue/queue.constants';
import type { FailedJobView } from '../ops.helpers';
import type { ProcessHeartbeat, ProcessMode } from '@/infra/heartbeat/heartbeat.service';
import type { QueueOverview, RetriedJob } from '../ops.service';

const QUEUE_NAME = { enum: QueueName, enumName: 'QueueName' } as const;

type QueueCounts = QueueOverview['counts'];

export class OpsQueueCountsResponse implements QueueCounts {
  @ApiProperty({ type: Number, minimum: 0, description: 'Waiting, including prioritized jobs' })
  waiting: number;

  @ApiProperty({ type: Number, minimum: 0 })
  active: number;

  @ApiProperty({ type: Number, minimum: 0 })
  delayed: number;

  @ApiProperty({ type: Number, minimum: 0 })
  failed: number;
}

export class OpsQueueOverviewResponse implements QueueOverview {
  @ApiProperty(QUEUE_NAME)
  name: QueueName;

  @ApiProperty({ type: String, description: 'What the queue does (queue policy table)' })
  purpose: string;

  @ApiProperty({ type: String, description: 'Module that owns the queue' })
  owner: string;

  @ApiProperty({
    type: Boolean,
    description: 'False when the feature the queue belongs to is switched off (no worker is expected)',
  })
  enabled: boolean;

  @ApiProperty({ type: Boolean })
  paused: boolean;

  @ApiProperty({ type: () => OpsQueueCountsResponse })
  counts: OpsQueueCountsResponse;

  @ApiProperty({ type: Number, minimum: 0, description: 'From the workers’ per-minute metrics' })
  completedLast24h: number;

  @ApiProperty({ type: Number, minimum: 0, description: 'From the workers’ per-minute metrics' })
  failedLast24h: number;

  @ApiProperty({
    type: Number,
    minimum: 0,
    nullable: true,
    description: 'Worker connections listening on the queue now; null when Redis does not allow counting them',
  })
  workers: number | null;
}

const PROCESS_MODES: ProcessMode[] = ['api', 'graphql', 'socket', 'worker', 'cron', 'grpc'];

/** One running process, from its heartbeat (every 30 s; listed until about 95 s after the last one). */
export class OpsProcessResponse implements ProcessHeartbeat {
  @ApiProperty({ enum: PROCESS_MODES, enumName: 'ProcessMode' })
  mode: ProcessMode;

  @ApiProperty({ type: String, example: 'ip-10-0-1-23:4127', description: 'Host and process id' })
  instance: string;

  @ApiDateTimeProperty()
  startedAt: string;

  @ApiDateTimeProperty({ description: 'Last heartbeat' })
  lastSeenAt: string;
}

/** One failed job; never the payload. */
export class OpsFailedJobResponse implements FailedJobView {
  @ApiProperty({ type: String, example: 'account-deletion-6720f0c2a1b2c3d4e5f60789' })
  id: string;

  @ApiProperty({ type: String, description: 'BullMQ job name' })
  name: string;

  @ApiProperty({ type: Number, minimum: 0 })
  attemptsMade: number;

  @ApiProperty({ type: Number, minimum: 1 })
  maxAttempts: number;

  @ApiProperty({ type: String, description: 'Last attempt’s error, secrets redacted, at most 500 characters' })
  failedReason: string;

  @ApiDateTimeProperty({ nullable: true })
  createdAt: Date | null;

  @ApiDateTimeProperty({ nullable: true })
  processedAt: Date | null;

  @ApiDateTimeProperty({ nullable: true })
  failedAt: Date | null;
}

export class OpsRetriedJobResponse implements RetriedJob {
  @ApiProperty(QUEUE_NAME)
  queue: QueueName;

  @ApiProperty({ type: String })
  id: string;

  @ApiProperty({ type: String })
  name: string;

  @ApiProperty({ type: String, enum: ['waiting'] })
  state: 'waiting';
}

/** An outbox event parked after too many failed deliveries (never its payload: it may hold personal data). */
export class OpsOutboxEventResponse {
  @ApiProperty({ type: String, example: '0b6c2f5e-6d1a-4b8f-9f0e-3a2b1c4d5e6f' })
  eventId: string;

  @ApiProperty({ type: String, example: 'user.deactivated' })
  type: string;

  @ApiProperty({ type: Number, example: 10 })
  attempts: number;

  @ApiProperty({ type: String, nullable: true, description: 'Last handler error (internal text, staff only)' })
  lastError: string | null;

  @ApiDateTimeProperty()
  occurredAt: string;
}

export class OpsOutboxRetriedResponse {
  @ApiProperty({ type: String })
  eventId: string;

  @ApiProperty({ type: String, enum: ['pending'] })
  status: 'pending';
}
