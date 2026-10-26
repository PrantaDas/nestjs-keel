/*
 * ─── PROCESSOR (worker process) ──────────────────────────────────────────────
 * One BullMQ processor per queue, extending `BaseProcessor` (timing logs, Sentry on final failure,
 * permanent errors fail at once instead of burning retries). Concurrency, attempts, backoff and
 * retention come from the queue's row in `infra/queue/queue-policies.ts`, never from here.
 * A job can run twice (retry, stalled worker, duplicate enqueue): `sendReminder` claims first.
 */
import { Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BaseProcessor } from '@/infra/queue/base.processor';
import { QueueName } from '@/infra/queue/queue.constants';
import { NotesService } from './notes.service';

export interface NoteReminderJob {
  noteId: string;
  /** ISO instant the reminder was due when queued; a changed reminder makes the claim fail (no send). */
  remindAt: string;
}

@Processor(QueueName.NOTES)
export class NotesProcessor extends BaseProcessor<NoteReminderJob, boolean> {
  constructor(private readonly notes: NotesService) {
    super();
  }

  protected handle(job: Job<NoteReminderJob>): Promise<boolean> {
    return this.notes.sendReminder(job.data.noteId, new Date(job.data.remindAt));
  }
}
