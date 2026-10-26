/*
 * ─── VIEWS ───────────────────────────────────────────────────────────────────
 * What leaves the server. Documents never go out as they are: views pick fields, rename them per API
 * version and hide internals (owner ids, deletion markers). Pure functions, easy to unit test.
 */
import type { NoteDoc } from './notes.repository';

export interface NoteReminderView {
  remindAt: Date;
  date: string;
  time: string;
  timeZone: string;
  sent: boolean;
}

export interface NoteView {
  _id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  reminder: NoteReminderView | null;
  createdDay: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NoteV2View extends Omit<NoteView, 'body' | 'createdDay' | 'createdAt'> {
  content: string;
  wordCount: number;
}

export function toNoteView(note: NoteDoc): NoteView {
  return {
    _id: note._id.toHexString(),
    title: note.title,
    body: note.body,
    tags: note.tags,
    pinned: note.pinned,
    reminder: note.reminder
      ? {
          remindAt: note.reminder.remindAt,
          date: note.reminder.date,
          time: note.reminder.time,
          timeZone: note.reminder.timeZone,
          sent: Boolean(note.reminder.sentAt),
        }
      : null,
    createdDay: note.createdDay,
    version: note.version,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

/** v2 renames `body` to `content` and adds a word count; the same data underneath. */
export function toNoteV2View(note: NoteDoc): NoteV2View {
  const { body, createdDay: _createdDay, createdAt: _createdAt, ...rest } = toNoteView(note);
  return { ...rest, content: body, wordCount: body.trim() ? body.trim().split(/\s+/).length : 0 };
}
