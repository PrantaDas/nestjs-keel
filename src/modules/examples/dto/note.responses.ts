/*
 * ─── RESPONSE MODELS (documentation only) ────────────────────────────────────
 * They mirror what the service returns (`NoteView`) so Swagger and generated clients get real
 * types. No CLI plugin: every property has a decorator with an explicit type. Class names become
 * schema names and must be unique across the app.
 */
import { ApiProperty } from '@nestjs/swagger';
import { ApiDateTimeProperty, ApiDayKeyProperty, ApiObjectIdProperty } from '@/common/swagger';

export class NoteReminderResponse {
  @ApiDateTimeProperty({ description: 'When it fires (UTC)' })
  remindAt: string;

  @ApiProperty({ type: String, example: '2026-10-14' })
  date: string;

  @ApiProperty({ type: String, example: '20:00' })
  time: string;

  @ApiProperty({ type: String, example: 'Asia/Dubai' })
  timeZone: string;

  @ApiProperty({ type: Boolean })
  sent: boolean;
}

/** v1 shape. */
export class NoteResponse {
  @ApiObjectIdProperty()
  _id: string;

  @ApiProperty({ type: String, example: 'Groceries' })
  title: string;

  @ApiProperty({ type: String, example: 'Milk, eggs, coffee' })
  body: string;

  @ApiProperty({ type: [String], example: ['home'] })
  tags: string[];

  @ApiProperty({ type: Boolean })
  pinned: boolean;

  @ApiProperty({ type: () => NoteReminderResponse, nullable: true })
  reminder: NoteReminderResponse | null;

  @ApiDayKeyProperty({ description: 'Business day the note was created on' })
  createdDay: string;

  @ApiProperty({ type: Number, example: 1, description: 'Send it back as `expectedVersion` when updating' })
  version: number;

  @ApiDateTimeProperty()
  createdAt: string;

  @ApiDateTimeProperty()
  updatedAt: string;
}

/** v2 shape: `body` is called `content`, and the word count is computed for the client. */
export class NoteV2Response {
  @ApiObjectIdProperty()
  _id: string;

  @ApiProperty({ type: String })
  title: string;

  @ApiProperty({ type: String })
  content: string;

  @ApiProperty({ type: Number, example: 3 })
  wordCount: number;

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({ type: Boolean })
  pinned: boolean;

  @ApiProperty({ type: () => NoteReminderResponse, nullable: true })
  reminder: NoteReminderResponse | null;

  @ApiProperty({ type: Number })
  version: number;

  @ApiDateTimeProperty()
  updatedAt: string;
}

export class TagCountResponse {
  @ApiProperty({ type: String, example: 'home' })
  tag: string;

  @ApiProperty({ type: Number, example: 4 })
  count: number;
}
