import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import { PaginatedResult, PaginationQueryDto } from '@/common/dto/pagination.dto';
import { TimeService } from '@/common/time/time.service';
import { BaseRepository, LeanDoc } from '@/infra/database/base.repository';
import { NotificationsErrors, NotificationsException } from './notifications.errors';
import { InboxItem } from './schemas/inbox-item.schema';

export interface InboxItemView {
  _id: string;
  source: string;
  title: string;
  body: string | null;
  data: Record<string, string> | null;
  read: boolean;
  createdAt: Date;
}

const toView = (item: LeanDoc<InboxItem>): InboxItemView => ({
  _id: item._id.toHexString(),
  source: item.source,
  title: item.title,
  body: item.body,
  data: item.data,
  read: Boolean(item.readAt),
  createdAt: item.createdAt,
});

/** The in-app notification list of the signed-in person. */
@Injectable()
export class InboxService extends BaseRepository<InboxItem> {
  constructor(
    @InjectModel(InboxItem.name) model: Model<InboxItem>,
    private readonly time: TimeService,
  ) {
    super(model);
  }

  async list(userId: string, query: PaginationQueryDto): Promise<PaginatedResult<InboxItemView>> {
    const page = await this.paginate(
      { userId: new Types.ObjectId(userId) },
      { page: query.page, limit: query.limit, sort: { createdAt: -1, _id: -1 } },
    );
    return new PaginatedResult(page.items.map(toView), page.meta);
  }

  async unreadCount(userId: string): Promise<{ unread: number }> {
    return { unread: await this.count({ userId: new Types.ObjectId(userId), readAt: null }) };
  }

  async markRead(userId: string, id: string): Promise<InboxItemView> {
    // Keeps the first read time when it is marked read twice.
    const item = isValidObjectId(id)
      ? await this.model
          .findOneAndUpdate(
            { _id: id, userId: new Types.ObjectId(userId) },
            [{ $set: { readAt: { $ifNull: ['$readAt', this.time.now()] } } }],
            { returnDocument: 'after', updatePipeline: true },
          )
          .lean<LeanDoc<InboxItem>>()
          .exec()
      : null;
    if (!item) throw new NotificationsException(NotificationsErrors.INBOX_ITEM_NOT_FOUND);
    return toView(item);
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    return {
      updated: await this.updateMany(
        { userId: new Types.ObjectId(userId), readAt: null },
        { $set: { readAt: this.time.now() } },
      ),
    };
  }

  /** Everything of a deleted account. */
  async removeForUser(userId: string): Promise<number> {
    return this.deleteMany({ userId: new Types.ObjectId(userId) });
  }
}
