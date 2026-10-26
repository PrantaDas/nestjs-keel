/*
 * ─── CRON (cron process) ─────────────────────────────────────────────────────
 * `@LockedCron` runs a tick once across every cron instance (Redis lock, renewed while it runs,
 * skipped, never run unlocked, when Redis is down) and requires an explicit time zone. Crons are
 * sweeps over stored state, so a tick missed while the process was down is caught up by the next.
 * Heavy work is enqueued for the worker; the cron itself only finds what is due.
 */
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { LockedCron } from '@/infra/cron/locked-cron.decorator';
import { QueueName } from '@/infra/queue/queue.constants';
import type { NoteReminderJob } from './notes.processor';
import { NotesService } from './notes.service';

const REMINDER_BATCH = 500;

@Injectable()
export class NotesCron {
  private readonly logger = new Logger(NotesCron.name);

  constructor(
    private readonly notes: NotesService,
    @InjectQueue(QueueName.NOTES) private readonly queue: Queue<NoteReminderJob>,
  ) {}

  /** Every minute (an interval: UTC). Deterministic job ids: a reminder is queued once per due time. */
  @LockedCron('* * * * *', { name: 'notes-reminders-due', timeZone: 'UTC' })
  async queueDueReminders(): Promise<void> {
    const due = await this.notes.dueReminders(REMINDER_BATCH);
    if (!due.length) return;
    await this.queue.addBulk(
      due.map((note) => {
        const remindAt = note.reminder!.remindAt.toISOString();
        return {
          name: 'reminder',
          data: { noteId: note._id.toHexString(), remindAt },
          opts: { jobId: `note-reminder-${note._id.toHexString()}-${note.reminder!.remindAt.getTime()}` },
        };
      }),
    );
    this.logger.log({ queued: due.length }, 'Due note reminders queued');
  }

  /** Daily at 03:00 business time: empty the bin of notes deleted more than 30 days ago. */
  @LockedCron('0 3 * * *', { name: 'notes-purge-deleted', timeZone: 'business' })
  async purgeDeleted(): Promise<void> {
    let total = 0;
    for (let removed = await this.notes.purgeDeleted(); removed > 0; removed = await this.notes.purgeDeleted()) {
      total += removed;
    }
    if (total) this.logger.log({ removed: total }, 'Deleted notes purged');
  }
}
