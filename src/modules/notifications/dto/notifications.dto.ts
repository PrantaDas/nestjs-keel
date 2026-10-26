import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
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
