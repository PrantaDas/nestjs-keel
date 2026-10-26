/*
 * ─── CONTROLLERS ─────────────────────────────────────────────────────────────
 * Thin: validate (DTO + pipes) → call the service → return plain data. The global interceptor wraps
 * it in `{ success, message, data, meta? }`; the global filter turns exceptions into the error
 * envelope. Every route declares, for Swagger and the contract test:
 *   @ApiOperation({ summary, operationId })  unique camelCase id; generated clients depend on it
 *   @ApiEnvelope / @ApiPaginated / @ApiNoContent   the success shape
 *   @ApiStandardErrors(...)                   the domain errors the service can throw
 *   @ResponseMessage('…')                     the human success message
 * Auth: every route needs a token unless `@Public()`; ownership is enforced in the service.
 *
 * Versioning (docs/conventions/versioning.md): `NotesController` serves v1 and v2 for the routes
 * that did not change; the read routes whose shape changed exist twice, side by side, and the v1
 * copies are `@Deprecated` (Deprecation + Sunset headers, 410 after the sunset day).
 */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/auth/auth.decorators';
import { Deprecated } from '@/common/decorators/deprecated.decorator';
import { ResponseMessage } from '@/common/decorators/response.decorators';
import { PaginatedResult } from '@/common/dto/pagination.dto';
import { ParseObjectIdPipe } from '@/common/pipes/parse-object-id.pipe';
import { ApiEnvelope, ApiEnvelopeArray, ApiNoContent, ApiPaginated, ApiStandardErrors } from '@/common/swagger';
import { CreateNoteDto, NoteQueryDto, UpdateNoteDto } from './dto/note.dto';
import { NoteResponse, NoteV2Response, TagCountResponse } from './dto/note.responses';
import { NotesErrors } from './notes.errors';
import { NotesService } from './notes.service';
import { toNoteV2View, toNoteView } from './notes.views';

/** v1 reads of notes: replaced by v2 (`content` instead of `body`), retired after the sunset day. */
const V1_SUNSET = { sunset: '2027-06-30', since: '2026-10-26' };

@ApiTags('Notes')
@ApiBearerAuth()
@Controller({ path: 'notes', version: ['1', '2'] })
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a note', operationId: 'notesCreate' })
  @ApiEnvelope(NoteResponse)
  @ApiStandardErrors(NotesErrors.NOTE_LIMIT_REACHED, NotesErrors.REMINDER_IN_PAST)
  @ResponseMessage('Note created.')
  async create(@CurrentUser('id') ownerId: string, @Body() dto: CreateNoteDto) {
    return toNoteView(await this.notes.create(ownerId, dto));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a note (send the version you read)', operationId: 'notesUpdate' })
  @ApiEnvelope(NoteResponse)
  @ApiStandardErrors(NotesErrors.NOTE_NOT_FOUND, NotesErrors.NOTE_EDITED_ELSEWHERE, NotesErrors.REMINDER_IN_PAST)
  @ResponseMessage('Note saved.')
  async update(
    @CurrentUser('id') ownerId: string,
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateNoteDto,
  ) {
    return toNoteView(await this.notes.update(ownerId, id, dto));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Move a note to the bin (restorable for 30 days)', operationId: 'notesDelete' })
  @ApiNoContent()
  @ApiStandardErrors(NotesErrors.NOTE_NOT_FOUND)
  async remove(@CurrentUser('id') ownerId: string, @Param('id', ParseObjectIdPipe) id: string): Promise<void> {
    await this.notes.remove(ownerId, id);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a note from the bin', operationId: 'notesRestore' })
  @ApiEnvelope(NoteResponse)
  @ApiStandardErrors(NotesErrors.NOTE_NOT_FOUND, NotesErrors.NOTE_NOT_DELETED)
  @ResponseMessage('Note restored.')
  async restore(@CurrentUser('id') ownerId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return toNoteView(await this.notes.restore(ownerId, id));
  }

  @Get('tags')
  @ApiOperation({ summary: 'My tags with how many notes use each', operationId: 'notesTags' })
  @ApiEnvelopeArray(TagCountResponse)
  @ResponseMessage('Tags loaded.')
  tags(@CurrentUser('id') ownerId: string) {
    return this.notes.tags(ownerId);
  }
}

/** v1 read routes, kept side by side with v2 until the sunset day. */
@ApiTags('Notes')
@ApiBearerAuth()
@Deprecated(V1_SUNSET)
@Controller({ path: 'notes', version: '1' })
export class NotesV1Controller {
  constructor(private readonly notes: NotesService) {}

  @Get()
  @ApiOperation({ summary: 'List my notes (v1, deprecated: use v2)', operationId: 'notesListV1', deprecated: true })
  @ApiPaginated(NoteResponse)
  @ResponseMessage('Notes loaded.')
  async list(@CurrentUser('id') ownerId: string, @Query() query: NoteQueryDto) {
    const page = await this.notes.list(ownerId, query);
    return new PaginatedResult(page.items.map(toNoteView), page.meta);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One note (v1, deprecated: use v2)', operationId: 'notesGetV1', deprecated: true })
  @ApiEnvelope(NoteResponse)
  @ApiStandardErrors(NotesErrors.NOTE_NOT_FOUND)
  @ResponseMessage('Note loaded.')
  async get(@CurrentUser('id') ownerId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return toNoteView(await this.notes.get(ownerId, id));
  }
}

/** v2 read routes: `content` and `wordCount` instead of `body`. */
@ApiTags('Notes')
@ApiBearerAuth()
@Controller({ path: 'notes', version: '2' })
export class NotesV2Controller {
  constructor(private readonly notes: NotesService) {}

  @Get()
  @ApiOperation({ summary: 'List my notes', operationId: 'notesList' })
  @ApiPaginated(NoteV2Response)
  @ResponseMessage('Notes loaded.')
  async list(@CurrentUser('id') ownerId: string, @Query() query: NoteQueryDto) {
    const page = await this.notes.list(ownerId, query);
    return new PaginatedResult(page.items.map(toNoteV2View), page.meta);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One note', operationId: 'notesGet' })
  @ApiEnvelope(NoteV2Response)
  @ApiStandardErrors(NotesErrors.NOTE_NOT_FOUND)
  @ResponseMessage('Note loaded.')
  async get(@CurrentUser('id') ownerId: string, @Param('id', ParseObjectIdPipe) id: string) {
    return toNoteV2View(await this.notes.get(ownerId, id));
  }
}
