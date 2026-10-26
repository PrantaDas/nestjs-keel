import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createHash } from 'node:crypto';
import { CurrentUser, RequirePermissions } from '@/common/auth/auth.decorators';
import { Permission } from '@/common/auth/permissions';
import { Notifier } from '@/common/contracts/notifier.contract';
import { Audit } from '@/common/decorators/audit.decorator';
import { ResponseMessage } from '@/common/decorators/response.decorators';
import { PaginationQueryDto } from '@/common/dto/pagination.dto';
import { SystemErrors } from '@/common/exceptions';
import { RequestContext } from '@/common/context/request-context';
import { ApiEnvelope, ApiPaginated, ApiStandardErrors } from '@/common/swagger';
import { PushSender } from '@/integrations/push/push.port';
import {
  AdminSendNotificationDto,
  AdminTopicMessageDto,
  InboxItemResponse,
  QueuedResponse,
  TopicParamDto,
  TopicSentResponse,
  UnreadCountResponse,
  UpdatedCountResponse,
} from './dto/notifications.dto';
import { InboxService } from './inbox.service';
import { NotificationsErrors } from './notifications.errors';

/** The signed-in person's in-app notifications. */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  @ApiOperation({ summary: 'My notifications, newest first', operationId: 'notificationsList' })
  @ApiPaginated(InboxItemResponse)
  @ResponseMessage('Notifications loaded.')
  list(@CurrentUser('id') userId: string, @Query() query: PaginationQueryDto) {
    return this.inbox.list(userId, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'How many of my notifications are unread', operationId: 'notificationsUnreadCount' })
  @ApiEnvelope(UnreadCountResponse)
  @ResponseMessage('Unread count loaded.')
  unread(@CurrentUser('id') userId: string) {
    return this.inbox.unreadCount(userId);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one notification read', operationId: 'notificationsMarkRead' })
  @ApiEnvelope(InboxItemResponse)
  @ApiStandardErrors(NotificationsErrors.INBOX_ITEM_NOT_FOUND)
  @ResponseMessage('Marked as read.')
  markRead(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.inbox.markRead(userId, id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all my notifications read', operationId: 'notificationsMarkAllRead' })
  @ApiEnvelope(UpdatedCountResponse)
  @ResponseMessage('All notifications marked as read.')
  markAllRead(@CurrentUser('id') userId: string) {
    return this.inbox.markAllRead(userId);
  }
}

/** Staff sends. Every send is audited; people who may not be contacted are always left out. */
@ApiTags('Admin · Notifications')
@ApiBearerAuth()
@RequirePermissions(Permission.NOTIFICATIONS_SEND)
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(
    private readonly notifier: Notifier,
    private readonly push: PushSender,
  ) {}

  @Post('send')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit({ action: 'notification.send', resource: 'notification' })
  @ApiOperation({ summary: 'Notify specific accounts (push, inbox, e-mail)', operationId: 'adminNotificationsSend' })
  @ApiEnvelope(QueuedResponse)
  @ApiStandardErrors(NotificationsErrors.TOO_MANY_RECIPIENTS)
  @ResponseMessage('Notification queued.')
  send(@Body() dto: AdminSendNotificationDto) {
    // The request id makes the occurrence unique per admin action; a retried request (Idempotency-Key) replays.
    const occurrenceKey = `admin:${RequestContext.requestId() ?? createHash('sha256').update(dto.title).digest('hex')}`;
    return this.notifier.notifyUsers({
      source: 'admin',
      occurrenceKey,
      userIds: dto.userIds,
      title: dto.title,
      body: dto.body,
      channels: dto.channels,
    });
  }

  @Post('topics/:topic')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit({ action: 'notification.topic', resource: 'topic', resourceIdParam: 'topic' })
  @ApiOperation({
    summary: 'Push to every device on a topic (`all` = every device)',
    operationId: 'adminNotificationsTopicSend',
  })
  @ApiEnvelope(TopicSentResponse)
  @ApiStandardErrors(SystemErrors.INTEGRATION_NOT_CONFIGURED, SystemErrors.INTEGRATION_FAILED)
  @ResponseMessage('Notification sent to the topic.')
  async sendToTopic(@Param() params: TopicParamDto, @Body() dto: AdminTopicMessageDto) {
    return { messageId: await this.push.sendToTopic(params.topic, { title: dto.title, body: dto.body }) };
  }
}
