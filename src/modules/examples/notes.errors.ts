/*
 * ─── ERRORS ──────────────────────────────────────────────────────────────────
 * Each module owns a code range (docs/conventions/errors.md lists them) and declares its catalogue
 * once. A duplicate or out-of-range code stops the boot. Messages are plain sentences for people:
 * test/unit/api-messages.spec.ts fails on internals (collection names, ids, "mongo") or jargon.
 */
import { HttpStatus } from '@nestjs/common';
import { BaseException, defineErrors, ErrorDefinition, ExceptionOptions } from '@/common/exceptions';

export const NotesErrors = defineErrors('notes', [5000, 5099], {
  NOTE_NOT_FOUND: {
    code: 5000,
    status: HttpStatus.NOT_FOUND,
    message: "We couldn't find that note. It may have been deleted.",
  },
  NOTE_LIMIT_REACHED: {
    code: 5001,
    status: HttpStatus.CONFLICT,
    message: 'You have reached the maximum number of notes. Delete some to add new ones.',
  },
  NOTE_EDITED_ELSEWHERE: {
    code: 5002,
    status: HttpStatus.CONFLICT,
    message: 'This note was changed somewhere else. Reload it and apply your changes again.',
  },
  REMINDER_IN_PAST: {
    code: 5003,
    status: HttpStatus.BAD_REQUEST,
    message: 'The reminder time has already passed. Choose a time in the future.',
  },
  NOTE_NOT_DELETED: {
    code: 5004,
    status: HttpStatus.CONFLICT,
    message: "This note isn't in the bin, so there is nothing to restore.",
  },
});

/** Thrown by the notes service; the global filter turns it into the error envelope. */
export class NotesException extends BaseException {
  constructor(definition: ErrorDefinition, options?: ExceptionOptions) {
    super(definition, options);
  }
}
