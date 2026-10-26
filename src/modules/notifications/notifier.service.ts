import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { DirectNotification, NotificationChannel, Notifier } from '@/common/contracts/notifier.contract';
import { UserDirectory } from '@/common/contracts/user-directory.contract';
import { QueueName } from '@/infra/queue/queue.constants';
import { MAX_RECIPIENTS, USERS_PER_JOB } from './notifications.constants';
import { NotificationsErrors, NotificationsException } from './notifications.errors';
import { NotificationDelivery } from './schemas/notification-delivery.schema';

export interface NotificationJob {
  source: string;
  occurrenceKey: string;
  userIds: string[];
  title: string;
  body?: string;
  data?: Record<string, string>;
  channels: NotificationChannel[];
}

const DEFAULT_CHANNELS: NotificationChannel[] = ['push', 'inbox'];

/**
 * `Notifier` port: records one delivery row per person and queues the sends. People who may not be
 * contacted are dropped here (first check) and again by the worker right before sending (second
 * check), because an account can be deactivated in between.
 */
@Injectable()
export class NotifierService extends Notifier {
  constructor(
    @InjectModel(NotificationDelivery.name) private readonly deliveries: Model<NotificationDelivery>,
    @InjectQueue(QueueName.NOTIFICATIONS) private readonly queue: Queue<NotificationJob>,
    private readonly directory: UserDirectory,
  ) {
    super();
  }

  async notifyUsers(notification: DirectNotification): Promise<{ queued: number }> {
    const requested = [...new Set(notification.userIds)].sort();
    if (requested.length > MAX_RECIPIENTS) throw new NotificationsException(NotificationsErrors.TOO_MANY_RECIPIENTS);
    const reachable = await this.directory.reachableUsers(requested);
    const userIds = requested.filter((id) => reachable.has(id));
    if (!userIds.length) return { queued: 0 };

    // One row per person; a repeat of the same (source, occurrence) inserts nothing new.
    const result = await this.deliveries
      .insertMany(
        userIds.map((id) => ({
          source: notification.source,
          occurrenceKey: notification.occurrenceKey,
          userId: new Types.ObjectId(id),
          status: 'queued',
        })),
        { ordered: false, rawResult: true },
      )
      .catch((error: unknown) => {
        if ((error as { code?: number }).code === 11000 || isBulkDuplicateOnly(error)) {
          return { insertedCount: (error as { insertedDocs?: unknown[] }).insertedDocs?.length ?? 0 };
        }
        throw error;
      });

    const channels = [...(notification.channels ?? DEFAULT_CHANNELS)];
    const jobs = chunk(userIds, USERS_PER_JOB).map((ids) => ({
      name: notification.source,
      data: {
        source: notification.source,
        occurrenceKey: notification.occurrenceKey,
        userIds: ids,
        title: notification.title,
        body: notification.body,
        data: notification.data,
        channels,
      },
      // Same occurrence and same people → same job id: a duplicate call queues nothing new.
      opts: { jobId: `notify-${digest(`${notification.source}|${notification.occurrenceKey}|${ids.join(',')}`)}` },
    }));
    await this.queue.addBulk(jobs);
    return { queued: 'insertedCount' in result ? Number(result.insertedCount) : userIds.length };
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** An unordered bulk insert where every failure is a duplicate key (already queued before). */
function isBulkDuplicateOnly(error: unknown): boolean {
  const writeErrors = (error as { writeErrors?: Array<{ code?: number; err?: { code?: number } }> }).writeErrors;
  return Array.isArray(writeErrors) && writeErrors.every((e) => (e.code ?? e.err?.code) === 11000);
}
