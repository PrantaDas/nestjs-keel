import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { NotificationChannel } from '@/common/contracts/notifier.contract';
import { ApiDateTimeProperty, ApiMapProperty, ApiObjectIdProperty } from '@/common/swagger';
import { MAX_RECIPIENTS } from '../notifications.constants';

const CHANNELS: NotificationChannel[] = ['push', 'inbox', 'email'];

export class AdminSendNotificationDto {
  @ApiProperty({ type: [String], description: `Account ids (at most ${MAX_RECIPIENTS})` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RECIPIENTS)
  @ArrayUnique()
  @IsMongoId({ each: true })
  userIds: string[];

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  body?: string;

  @ApiPropertyOptional({ enum: CHANNELS, isArray: true, default: ['push', 'inbox'] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(CHANNELS, { each: true })
  channels?: NotificationChannel[];
}

export class AdminTopicMessageDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  body?: string;
}

export class TopicParamDto {
  @ApiProperty({ example: 'all' })
  @Matches(/^[a-zA-Z0-9-_.~%]{1,100}$/, { message: 'Topic must be letters, digits or - _ . ~ only.' })
  topic: string;
}

export class InboxItemResponse {
  @ApiObjectIdProperty()
  _id: string;

  @ApiProperty({ type: String, example: 'note-reminder' })
  source: string;

  @ApiProperty({ type: String })
  title: string;

  @ApiProperty({ type: String, nullable: true })
  body: string | null;

  @ApiMapProperty({ type: 'string' }, { nullable: true, description: 'Deep-link data sent with the push' })
  data: Record<string, string> | null;

  @ApiProperty({ type: Boolean })
  read: boolean;

  @ApiDateTimeProperty()
  createdAt: string;
}

export class UnreadCountResponse {
  @ApiProperty({ type: Number })
  unread: number;
}

export class UpdatedCountResponse {
  @ApiProperty({ type: Number })
  updated: number;
}

export class QueuedResponse {
  @ApiProperty({ type: Number, description: 'People a delivery was queued for (unreachable accounts are left out)' })
  queued: number;
}

export class TopicSentResponse {
  @ApiProperty({ type: String })
  messageId: string;
}

/** Base64url, as browsers encode `PushSubscription` keys (65-byte P-256 point, 16-byte secret). */
const P256DH = /^[A-Za-z0-9_-]{87}=?$/;
const AUTH_SECRET = /^[A-Za-z0-9_-]{22}(==)?$/;
const SUBSCRIPTION_FORMAT = "Subscription details aren't in the right format.";

export class WebPushKeysDto {
  @ApiProperty({
    description: "The browser's P-256 public key (base64url)",
    example: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  })
  @IsString()
  @Matches(P256DH, { message: SUBSCRIPTION_FORMAT })
  p256dh: string;

  @ApiProperty({ description: "The browser's auth secret (base64url)", example: 'tBHItJI5svbpez7KI4CCXg' })
  @IsString()
  @Matches(AUTH_SECRET, { message: SUBSCRIPTION_FORMAT })
  auth: string;
}

/** `PushSubscription.toJSON()` as the browser returns it, plus an optional label for my list. */
export class WebPushSubscribeDto {
  @ApiProperty({ maxLength: 2048, example: 'https://fcm.googleapis.com/fcm/send/dpH5lCsTSSM:APA91bH…' })
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: true })
  @MaxLength(2048)
  endpoint: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'When the subscription stops working (Unix milliseconds); null = no end',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expirationTime?: number | null;

  @ApiProperty({ type: () => WebPushKeysDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => WebPushKeysDto)
  keys: WebPushKeysDto;

  @ApiPropertyOptional({
    maxLength: 100,
    example: 'Firefox on Windows',
    description: 'Shown in the list of my browsers',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}

export class WebPushUnsubscribeDto {
  @ApiProperty({ maxLength: 2048, description: 'The `endpoint` of the subscription being removed' })
  @IsString()
  @MaxLength(2048)
  endpoint: string;
}

export class WebPushPublicKeyResponse {
  @ApiProperty({
    type: String,
    description: 'VAPID public key (base64url): pass it as `applicationServerKey` to `pushManager.subscribe`',
  })
  publicKey: string;
}

export class WebPushSubscriptionResponse {
  @ApiObjectIdProperty()
  _id: string;

  @ApiProperty({ type: String, nullable: true, example: 'Firefox on Windows' })
  label: string | null;

  @ApiProperty({ type: String, example: 'fcm.googleapis.com', description: 'Push service host' })
  service: string;

  @ApiDateTimeProperty({ nullable: true })
  expiresAt: string | null;

  @ApiDateTimeProperty()
  lastSeenAt: string;

  @ApiDateTimeProperty()
  createdAt: string;
}
