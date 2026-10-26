/*
 * ─── DTOs (request input) ────────────────────────────────────────────────────
 * class-validator decorators validate, class-transformer converts, @nestjs/swagger documents. The
 * global ValidationPipe rejects unknown fields and writes the human message itself from the rule
 * and the field's label ("Title must be 200 characters or fewer."), so decorators need no message.
 * Wall-clock input is `LocalDateTimeDto` ({ date, time, timeZone }), never a bare string.
 * The same classes are GraphQL input types (`@InputType` + `@Field`), so REST and GraphQL share one
 * set of rules and messages.
 */
import { Field, InputType, Int } from '@nestjs/graphql';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '@/common/dto/pagination.dto';
import { LocalDateTimeDto } from '@/common/time/time.validators';

export const MAX_TAGS = 20;

/** `" Work "` → `"work"`; lists are deduplicated after normalising. */
const normalizeTags = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? [...new Set((value as unknown[]).map((tag) => (typeof tag === 'string' ? tag.trim().toLowerCase() : tag)))]
    : value;

@InputType('CreateNoteInput')
export class CreateNoteDto {
  @ApiProperty({ example: 'Groceries', maxLength: 200 })
  @Field(() => String)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ example: 'Milk, eggs, coffee', maxLength: 10_000 })
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  body?: string;

  @ApiPropertyOptional({ type: [String], example: ['home', 'weekly'], maxItems: MAX_TAGS })
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @Transform(normalizeTags)
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[a-z0-9][a-z0-9-]{0,29}$/, {
    each: true,
    message: 'Each tag must be 1 to 30 letters, digits or dashes.',
  })
  tags?: string[];

  @ApiPropertyOptional({ default: false })
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({ type: () => LocalDateTimeDto, description: 'When to send a reminder, as the person sees it' })
  @Field(() => LocalDateTimeDto, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocalDateTimeDto)
  reminder?: LocalDateTimeDto;
}

/**
 * Every field optional, `reminder: null` clears it, and the version read is required. Written out
 * rather than derived (`PartialType`) so one class carries both the Swagger and the GraphQL fields.
 */
@InputType('UpdateNoteInput')
export class UpdateNoteDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 10_000 })
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  body?: string;

  @ApiPropertyOptional({ type: [String], maxItems: MAX_TAGS })
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @Transform(normalizeTags)
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[a-z0-9][a-z0-9-]{0,29}$/, {
    each: true,
    message: 'Each tag must be 1 to 30 letters, digits or dashes.',
  })
  tags?: string[];

  @ApiPropertyOptional()
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({ type: () => LocalDateTimeDto, nullable: true, description: '`null` removes the reminder' })
  @Field(() => LocalDateTimeDto, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocalDateTimeDto)
  reminder?: LocalDateTimeDto | null;

  @ApiProperty({ example: 3, description: 'The `version` you read; a stale one gets 409 NOTE_EDITED_ELSEWHERE' })
  @Field(() => Int)
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export const NOTE_SORTS = ['-updatedAt', 'updatedAt', '-createdAt', 'createdAt', 'title'] as const;
export type NoteSort = (typeof NOTE_SORTS)[number];

export class NoteQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'home' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  tag?: string;

  @ApiPropertyOptional({ description: 'Start of the title (case-insensitive)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: NOTE_SORTS, default: '-updatedAt', description: 'Pinned notes always come first' })
  @IsOptional()
  @IsIn(NOTE_SORTS)
  sort: NoteSort = '-updatedAt';
}
