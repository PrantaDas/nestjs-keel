import { Processor } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import type { Job } from 'bullmq';
import { Model, Types } from 'mongoose';
import { ReachableUser, UserDirectory } from '@/common/contracts/user-directory.contract';
import { BaseException, SystemErrors } from '@/common/exceptions';
import { TimeService } from '@/common/time/time.service';
import { BaseProcessor } from '@/infra/queue/base.processor';
import { QueueName } from '@/infra/queue/queue.constants';
import { MailSender } from '@/integrations/mail/mail.port';
import { PUSH_MAX_BATCH, PushSender, PushTokenMessage } from '@/integrations/push/push.port';
import { DeviceRegistryService } from './device-registry.service';
import type { NotificationJob } from './notifier.service';
import { InboxItem } from './schemas/inbox-item.schema';
import { NotificationDelivery } from './schemas/notification-delivery.schema';

interface PushTally {
  sent: number;
  failed: number;
}

const notConfigured = (error: unknown) =>
  error instanceof BaseException && error.errorCode === SystemErrors.INTEGRATION_NOT_CONFIGURED.code;

/**
 * Sends one batch of a `Notifier` request (≤ 500 people).
 *
 * 1. Claims the batch's `queued` delivery rows with this attempt's token: rows another attempt or a
 *    duplicate job already claimed are never touched again, so a retry cannot push twice.
 * 2. Checks again who may be contacted (an account may have been deactivated since it was queued):
 *    the others are marked `skipped` and get nothing: no inbox row, no push, no e-mail.
 * 3. Writes inbox rows, sends pushes in batches (dead tokens are deleted), sends e-mails (claimed
 *    per person), then records the outcome. A provider failure marks the rows failed; never re-sent.
 */
@Processor(QueueName.NOTIFICATIONS)
export class NotificationsProcessor extends BaseProcessor<NotificationJob> {
  constructor(
    @InjectModel(NotificationDelivery.name) private readonly deliveries: Model<NotificationDelivery>,
    @InjectModel(InboxItem.name) private readonly inbox: Model<InboxItem>,
    private readonly directory: UserDirectory,
    private readonly devices: DeviceRegistryService,
    private readonly push: PushSender,
    private readonly mail: MailSender,
    private readonly time: TimeService,
  ) {
    super();
  }

  protected async handle(job: Job<NotificationJob>): Promise<{ sent: number; skipped: number }> {
    const { source, occurrenceKey } = job.data;
    const claimToken = `${job.id}:${job.attemptsMade}`;
    await this.deliveries.updateMany(
      {
        source,
        occurrenceKey,
        userId: { $in: job.data.userIds.map((id) => new Types.ObjectId(id)) },
        status: 'queued',
      },
      { $set: { status: 'sending', claimedAt: this.time.now(), claimToken } },
    );
    const claimed = await this.deliveries.find({ claimToken }, { userId: 1 }).lean().exec();
    if (!claimed.length) return { sent: 0, skipped: 0 };

    // Second check, right before sending.
    const reachable = await this.directory.reachableUsers(claimed.map((row) => row.userId.toHexString()));
    const skipped = claimed.filter((row) => !reachable.has(row.userId.toHexString())).map((row) => row.userId);
    if (skipped.length) {
      await this.deliveries.updateMany({ claimToken, userId: { $in: skipped } }, { $set: { status: 'skipped' } });
    }
    const people = [...reachable.values()];
    if (!people.length) return { sent: 0, skipped: skipped.length };

    try {
      if (job.data.channels.includes('inbox')) await this.writeInbox(job.data, people);
      const pushes = job.data.channels.includes('push')
        ? await this.sendPushes(job.data, people)
        : new Map<string, PushTally>();
      if (job.data.channels.includes('email')) await this.sendEmails(job.data, people);
      await this.deliveries.bulkWrite(
        people.map((person) => ({
          updateOne: {
            filter: { claimToken, userId: new Types.ObjectId(person.id) },
            update: {
              $set: {
                status: 'sent',
                pushSent: pushes.get(person.id)?.sent ?? 0,
                pushFailed: pushes.get(person.id)?.failed ?? 0,
              },
            },
          },
        })),
      );
    } catch (error) {
      // Claimed rows are never re-sent: record the failure; the job fails for ops to see.
      await this.deliveries.updateMany(
        { claimToken, status: 'sending' },
        { $set: { status: 'failed', error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' } },
      );
      throw error;
    }
    return { sent: people.length, skipped: skipped.length };
  }

  private async writeInbox(job: NotificationJob, people: ReachableUser[]): Promise<void> {
    await this.inbox.bulkWrite(
      people.map((person) => ({
        updateOne: {
          filter: { userId: new Types.ObjectId(person.id), source: job.source, occurrenceKey: job.occurrenceKey },
          update: {
            $setOnInsert: { title: job.title, body: job.body ?? null, data: job.data ?? null, readAt: null },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  private async sendPushes(job: NotificationJob, people: ReachableUser[]): Promise<Map<string, PushTally>> {
    const tally = new Map<string, PushTally>();
    const tokens = await this.devices.tokensFor(people.map((person) => new Types.ObjectId(person.id)));
    const messages: Array<PushTokenMessage & { userId: string }> = tokens.map((row) => ({
      userId: row.userId.toHexString(),
      token: row.token,
      title: job.title,
      body: job.body,
      data: job.data,
    }));
    const dead: string[] = [];
    for (let i = 0; i < messages.length; i += PUSH_MAX_BATCH) {
      const batch = messages.slice(i, i + PUSH_MAX_BATCH);
      let outcomes;
      try {
        outcomes = await this.push.sendEach(batch.map(({ userId: _userId, ...message }) => message));
      } catch (error) {
        // Push not set up: the inbox (and e-mail) still deliver; nothing to retry.
        if (notConfigured(error)) return tally;
        throw error;
      }
      outcomes.forEach((outcome, index) => {
        const { userId, token } = batch[index];
        const entry = tally.get(userId) ?? { sent: 0, failed: 0 };
        if (outcome.ok) entry.sent += 1;
        else entry.failed += 1;
        if (outcome.invalidToken) dead.push(token);
        tally.set(userId, entry);
      });
    }
    await this.devices.prune(dead);
    return tally;
  }

  private async sendEmails(job: NotificationJob, people: ReachableUser[]): Promise<void> {
    for (const person of people) {
      if (!person.email || !person.emailVerified) continue;
      try {
        await this.mail.send(
          {
            to: person.email,
            subject: job.title,
            text: job.body ?? job.title,
            html: `<p>${escapeHtml(job.body ?? job.title)}</p>`,
          },
          // One e-mail per person and occurrence, whatever happens to the job.
          { onceKey: `notify:${job.source}:${job.occurrenceKey}:${person.id}` },
        );
      } catch (error) {
        if (notConfigured(error)) return;
        throw error;
      }
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
