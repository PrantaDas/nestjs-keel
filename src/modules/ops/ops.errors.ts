import { HttpStatus } from '@nestjs/common';
import { BaseException, defineErrors, ErrorDefinition, ExceptionOptions } from '@/common/exceptions';

/** Ops: queues, failed jobs, outbox. Range 7000–7099. */
export const OpsErrors = defineErrors('ops', [7000, 7099], {
  OPS_QUEUE_NOT_FOUND: {
    code: 7000,
    status: HttpStatus.NOT_FOUND,
    message: 'There is no background task list with this name.',
  },
  OPS_JOB_NOT_FOUND: {
    code: 7001,
    status: HttpStatus.NOT_FOUND,
    message: 'This job no longer exists. It may have been cleaned up or discarded.',
  },
  OPS_JOB_NOT_FAILED: {
    code: 7002,
    status: HttpStatus.CONFLICT,
    message: 'This job is no longer in the failed list. It may have been retried, discarded or be running.',
  },
  OPS_EVENT_NOT_FOUND: {
    code: 7003,
    status: HttpStatus.NOT_FOUND,
    message: 'There is no parked event with this id. It may have been delivered or retried already.',
  },
});

export class OpsException extends BaseException {
  constructor(definition: ErrorDefinition, options?: ExceptionOptions) {
    super(definition, options);
  }
}
