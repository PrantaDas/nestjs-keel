import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public } from '@/common/auth/auth.decorators';
import type { AuthUser } from '@/common/auth/auth.types';
import { RequestContext } from '@/common/context/request-context';
import { Notifier } from '@/common/contracts/notifier.contract';
import { ResponseMessage } from '@/common/decorators/response.decorators';
import { SystemErrors } from '@/common/exceptions';
import { ApiEnvelope, ApiEnvelopeArray, ApiEnvelopeNull, ApiNoContent, ApiStandardErrors } from '@/common/swagger';
import { OtpThrottle } from '@/infra/security/throttle.decorators';
import {
  QueuedResponse,
  WebPushPublicKeyResponse,
  WebPushSubscribeDto,
  WebPushSubscriptionResponse,
  WebPushUnsubscribeDto,
} from './dto/notifications.dto';
import { NotificationsErrors } from './notifications.errors';
import { WebPushSubscriptionsService } from './web-push-subscriptions.service';

/** Public: the key is the public half of the VAPID pair, and a page may fetch it before sign-in. */
@ApiTags('Notifications · Browser push')
@Controller('notifications/web-push')
export class WebPushKeyController {
  constructor(private readonly subscriptions: WebPushSubscriptionsService) {}

  @Get('public-key')
  @Public()
  @ApiOperation({
    summary: 'The application server key a browser subscribes with',
    operationId: 'notificationsWebPushPublicKey',
  })
  @ApiEnvelope(WebPushPublicKeyResponse)
  @ApiStandardErrors(SystemErrors.INTEGRATION_NOT_CONFIGURED)
  @ResponseMessage('Browser notification settings loaded.')
  publicKey() {
    return this.subscriptions.publicKey();
  }
}

/**
 * Browser notifications (Web Push with VAPID). The page fetches the public key, calls
 * `pushManager.subscribe`, and sends the resulting subscription here; from then on every `Notifier`
 * send with the `push` channel reaches this browser too. Signing the session out unsubscribes it.
 */
@ApiTags('Notifications · Browser push')
@ApiBearerAuth()
@Controller('notifications/web-push')
export class WebPushController {
  constructor(
    private readonly subscriptions: WebPushSubscriptionsService,
    private readonly notifier: Notifier,
  ) {}

  @Put('subscriptions')
  @ApiOperation({
    summary: 'Register or refresh this browser for notifications',
    operationId: 'notificationsWebPushSubscribe',
  })
  @ApiEnvelope(WebPushSubscriptionResponse)
  @ApiStandardErrors(NotificationsErrors.WEB_PUSH_SERVICE_NOT_SUPPORTED, SystemErrors.INTEGRATION_NOT_CONFIGURED)
  @ResponseMessage('This browser will now receive notifications.')
  subscribe(@CurrentUser() user: AuthUser, @Body() dto: WebPushSubscribeDto) {
    return this.subscriptions.subscribe(user.id, { ...dto, sessionId: user.sessionId });
  }

  @Get('subscriptions')
  @ApiOperation({ summary: 'The browsers that receive my notifications', operationId: 'notificationsWebPushList' })
  @ApiEnvelopeArray(WebPushSubscriptionResponse)
  @ResponseMessage('Browsers loaded.')
  list(@CurrentUser('id') userId: string) {
    return this.subscriptions.list(userId);
  }

  @Delete('subscriptions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Stop notifications to one of my browsers', operationId: 'notificationsWebPushRemove' })
  @ApiNoContent()
  @ApiStandardErrors(NotificationsErrors.WEB_PUSH_SUBSCRIPTION_NOT_FOUND)
  async remove(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<void> {
    await this.subscriptions.remove(userId, id);
  }

  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stop notifications to this browser (after `subscription.unsubscribe()`)',
    operationId: 'notificationsWebPushUnsubscribe',
  })
  @ApiEnvelopeNull()
  @ResponseMessage('This browser will no longer receive notifications.')
  async unsubscribe(@CurrentUser('id') userId: string, @Body() dto: WebPushUnsubscribeDto): Promise<null> {
    await this.subscriptions.unsubscribe(userId, dto.endpoint);
    return null;
  }

  @Post('test')
  @HttpCode(HttpStatus.ACCEPTED)
  @OtpThrottle()
  @ApiOperation({ summary: 'Send a test push to my browsers and devices', operationId: 'notificationsWebPushTest' })
  @ApiEnvelope(QueuedResponse)
  @ResponseMessage('Test notification on its way.')
  test(@CurrentUser('id') userId: string) {
    return this.notifier.notifyUsers({
      source: 'push-test',
      // Each press is its own occurrence; a retried request (Idempotency-Key) replays the first.
      occurrenceKey: RequestContext.requestId() ?? `${userId}:test`,
      userIds: [userId],
      title: 'Notifications are working',
      body: 'This is a test from your account settings.',
      channels: ['push'],
    });
  }
}
