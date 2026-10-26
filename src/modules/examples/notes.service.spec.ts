/*
 * ─── UNIT TESTS ──────────────────────────────────────────────────────────────
 * Business rules with the collaborators faked: no database, no Redis, a frozen clock. Wiring,
 * persistence and HTTP are covered end to end in test/e2e/notes.e2e-spec.ts.
 */
import { Types } from 'mongoose';
import { FixedClock } from '@/common/time/clock';
import { timePolicy } from '@/common/time/time-policy';
import { TimeService } from '@/common/time/time.service';
import { NotesException } from './notes.errors';
import type { NoteDoc, NotesRepository } from './notes.repository';
import { MAX_NOTES_PER_OWNER, NotesService } from './notes.service';
import { toNoteV2View, toNoteView } from './notes.views';

const OWNER = new Types.ObjectId().toHexString();

function note(overrides: Partial<NoteDoc> = {}): NoteDoc {
  return {
    _id: new Types.ObjectId(),
    ownerId: new Types.ObjectId(OWNER),
    title: 'Groceries',
    body: 'milk  eggs\ncoffee',
    tags: ['home'],
    pinned: false,
    reminder: null,
    createdDay: '2026-10-26',
    version: 1,
    createdAt: new Date('2026-10-26T08:00:00Z'),
    updatedAt: new Date('2026-10-26T08:00:00Z'),
    ...overrides,
  } as NoteDoc;
}

describe('NotesService', () => {
  const clock = new FixedClock('2026-10-26T21:30:00Z'); // 01:30 on the 27th in Dubai
  const time = new TimeService(clock, timePolicy({ businessTimeZone: 'Asia/Dubai', weekStartsOn: 'monday' }));
  let repository: jest.Mocked<
    Pick<NotesRepository, 'countLive' | 'create' | 'findOwned' | 'updateIfVersion' | 'claimReminder'>
  >;
  let notifier: { notifyUsers: jest.Mock };
  let service: NotesService;

  beforeEach(() => {
    repository = {
      countLive: jest.fn().mockResolvedValue(0),
      create: jest.fn((data: Partial<NoteDoc>) => Promise.resolve(note(data))),
      findOwned: jest.fn(),
      updateIfVersion: jest.fn(),
      claimReminder: jest.fn(),
    };
    notifier = { notifyUsers: jest.fn().mockResolvedValue({ queued: 1 }) };
    service = new NotesService(
      repository as unknown as NotesRepository,
      { run: (work: (session: undefined) => unknown) => work(undefined) } as never,
      { add: jest.fn() } as never,
      { invalidateTag: jest.fn().mockResolvedValue(undefined), wrap: jest.fn() } as never,
      { toUser: jest.fn() } as never,
      { publish: jest.fn().mockResolvedValue(undefined) } as never,
      notifier,
      time,
    );
  });

  it('stores the business day of creation, computed in the business zone', async () => {
    await service.create(OWNER, { title: 'Late night note' });
    expect(repository.create.mock.calls[0][0]).toMatchObject({ createdDay: '2026-10-27', version: 1 });
  });

  it('refuses a new note past the per-owner limit', async () => {
    repository.countLive.mockResolvedValue(MAX_NOTES_PER_OWNER);
    await expect(service.create(OWNER, { title: 'One too many' })).rejects.toMatchObject({
      error: 'NOTE_LIMIT_REACHED',
    });
  });

  it('converts a wall-clock reminder to an instant and refuses one in the past', async () => {
    await service.create(OWNER, {
      title: 'Call',
      reminder: { date: '2026-10-27', time: '09:00', timeZone: 'Asia/Dubai' } as never,
    });
    expect(repository.create.mock.calls[0][0].reminder).toMatchObject({
      remindAt: new Date('2026-10-27T05:00:00Z'),
      timeZone: 'Asia/Dubai',
      sentAt: null,
    });
    await expect(
      service.create(OWNER, {
        title: 'Too late',
        reminder: { date: '2026-10-27', time: '01:00', timeZone: 'Asia/Dubai' } as never,
      }),
    ).rejects.toMatchObject({ error: 'REMINDER_IN_PAST' });
  });

  it('reports a stale version as an edit made elsewhere, with the latest version', async () => {
    repository.findOwned.mockResolvedValue(note({ version: 4 }));
    repository.updateIfVersion.mockResolvedValue(null);
    const error = (await service
      .update(OWNER, new Types.ObjectId().toHexString(), { title: 'x', expectedVersion: 3 })
      .catch((e: unknown) => e)) as NotesException;
    expect(error).toBeInstanceOf(NotesException);
    expect(error.details).toEqual([expect.objectContaining({ field: 'expectedVersion', latestVersion: 4 })]);
  });

  it('sends a reminder only when it wins the claim, with an occurrence key per due time', async () => {
    const due = note({ title: 'Stand-up' });
    repository.claimReminder.mockResolvedValueOnce(due).mockResolvedValueOnce(null);
    const at = new Date('2026-10-27T05:00:00Z');
    await expect(service.sendReminder(due._id.toHexString(), at)).resolves.toBe(true);
    await expect(service.sendReminder(due._id.toHexString(), at)).resolves.toBe(false);
    expect(notifier.notifyUsers).toHaveBeenCalledTimes(1);
    expect(notifier.notifyUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'note-reminder',
        occurrenceKey: `${due._id.toHexString()}-2026-10-27T05:00:00.000Z`,
        userIds: [OWNER],
        title: 'Reminder: Stand-up',
      }),
    );
  });
});

describe('note views', () => {
  it('hides internals and renames per API version', () => {
    const doc = note({ deletedAt: null });
    const v1 = toNoteView(doc);
    expect(v1).not.toHaveProperty('ownerId');
    expect(v1).not.toHaveProperty('deletedAt');
    expect(toNoteV2View(doc)).toMatchObject({ content: 'milk  eggs\ncoffee', wordCount: 3 });
    expect(toNoteV2View(note({ body: '   ' })).wordCount).toBe(0);
  });
});
