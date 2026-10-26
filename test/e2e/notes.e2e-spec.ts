import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { FixedClock } from '@/common/time/clock';
import { NotesCronModule, NotesJobsModule } from '@/modules/examples/notes.module';
import { NotesCron } from '@/modules/examples/notes.cron';
import { NotesService } from '@/modules/examples/notes.service';
import { NotificationsJobsModule } from '@/modules/notifications/notifications.module';
import { createTestApp, TestApp } from './app';
import { API, eventually, signUp } from './helpers';

const V2 = '/api/v2';

/**
 * The example module end to end: CRUD, ownership, validation, optimistic concurrency, the bin,
 * API versioning with deprecation headers, the tag cache, and reminders through cron → queue →
 * processor → Notifier → push, on a frozen clock.
 */
describe('Examples: notes (e2e)', () => {
  // A fixed "now" far from midnight in Dubai (the e2e business zone) and from any DST change.
  const clock = new FixedClock('2026-10-26T08:00:00Z');
  let t: TestApp;

  beforeAll(async () => {
    // No ScheduleModule: crons never fire on their own here, the test calls them.
    t = await createTestApp({ clock, imports: [NotesJobsModule, NotesCronModule, NotificationsJobsModule] });
  });

  afterAll(() => t.close());

  it('creates, reads, edits and lists notes; v1 and v2 side by side', async () => {
    const me = await signUp(t.http);
    const created = await t.http
      .post(`${API}/notes`)
      .set(me.auth)
      .send({ title: 'Groceries', body: 'milk eggs coffee', tags: [' Home ', 'home', 'weekly'] })
      .expect(201);
    expect(created.body).toMatchObject({
      message: 'Note created.',
      data: { title: 'Groceries', tags: ['home', 'weekly'], version: 1, pinned: false, createdDay: '2026-10-26' },
    });
    const id = created.body.data._id as string;

    const v1 = await t.http.get(`${API}/notes/${id}`).set(me.auth).expect(200);
    expect(v1.body.data.body).toBe('milk eggs coffee');
    expect(v1.headers.deprecation).toBe(`@${Date.UTC(2026, 9, 26) / 1000}`);
    expect(v1.headers.sunset).toBe('Wed, 30 Jun 2027 00:00:00 GMT');
    expect(v1.headers.link).toBeUndefined();

    const v2 = await t.http.get(`${V2}/notes/${id}`).set(me.auth).expect(200);
    expect(v2.body.data).toMatchObject({ content: 'milk eggs coffee', wordCount: 3 });
    expect(v2.body.data.body).toBeUndefined();
    expect(v2.headers.deprecation).toBeUndefined();

    const edited = await t.http
      .patch(`${V2}/notes/${id}`)
      .set(me.auth)
      .send({ pinned: true, expectedVersion: 1 })
      .expect(200);
    expect(edited.body.data).toMatchObject({ pinned: true, version: 2 });

    await t.http.post(`${API}/notes`).set(me.auth).send({ title: 'Another' }).expect(201);
    const list = await t.http.get(`${V2}/notes`).set(me.auth).query({ limit: 10 }).expect(200);
    expect(list.body.data.map((n: { title: string }) => n.title)).toEqual(['Groceries', 'Another']);
    expect(list.body.meta).toMatchObject({ totalDocs: 2, page: 1 });
    const filtered = await t.http.get(`${V2}/notes`).set(me.auth).query({ tag: 'weekly' }).expect(200);
    expect(filtered.body.data).toHaveLength(1);
  });

  it('keeps notes private: another account reads them as missing', async () => {
    const owner = await signUp(t.http);
    const other = await signUp(t.http);
    const note = await t.http.post(`${API}/notes`).set(owner.auth).send({ title: 'Mine' }).expect(201);
    const res = await t.http.get(`${V2}/notes/${note.body.data._id}`).set(other.auth).expect(404);
    expect(res.body.error).toBe('NOTE_NOT_FOUND');
    await t.http.delete(`${API}/notes/${note.body.data._id}`).set(other.auth).expect(404);
  });

  it('refuses a stale edit with the latest version in details', async () => {
    const me = await signUp(t.http);
    const note = (await t.http.post(`${API}/notes`).set(me.auth).send({ title: 'Draft' }).expect(201)).body.data;
    await t.http
      .patch(`${API}/notes/${note._id}`)
      .set(me.auth)
      .send({ title: 'First', expectedVersion: 1 })
      .expect(200);
    const stale = await t.http
      .patch(`${API}/notes/${note._id}`)
      .set(me.auth)
      .send({ title: 'Second', expectedVersion: 1 })
      .expect(409);
    expect(stale.body).toMatchObject({
      error: 'NOTE_EDITED_ELSEWHERE',
      details: [{ field: 'expectedVersion', latestVersion: 2 }],
    });
  });

  it('validates with human messages and rejects unknown fields', async () => {
    const me = await signUp(t.http);
    const res = await t.http
      .post(`${API}/notes`)
      .set(me.auth)
      .send({ title: 'x'.repeat(201), tags: ['Not valid!'], ownerId: 'someone-else' })
      .expect(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        { field: 'title', message: 'Title must be 200 characters or fewer.' },
        { field: 'tags', message: 'Each tag must be 1 to 30 letters, digits or dashes.' },
        { field: 'ownerId', message: "This field isn't allowed." },
      ]),
    );
  });

  it('moves a note to the bin and restores it', async () => {
    const me = await signUp(t.http);
    const note = (await t.http.post(`${API}/notes`).set(me.auth).send({ title: 'Bin me' }).expect(201)).body.data;
    await t.http.delete(`${API}/notes/${note._id}`).set(me.auth).expect(204);
    await t.http.get(`${V2}/notes/${note._id}`).set(me.auth).expect(404);
    const restored = await t.http.post(`${API}/notes/${note._id}/restore`).set(me.auth).expect(200);
    expect(restored.body.data.title).toBe('Bin me');
    const twice = await t.http.post(`${API}/notes/${note._id}/restore`).set(me.auth).expect(409);
    expect(twice.body.error).toBe('NOTE_NOT_DELETED');
  });

  it('counts tags through the cache and refreshes them after a change', async () => {
    const me = await signUp(t.http);
    await t.http
      .post(`${API}/notes`)
      .set(me.auth)
      .send({ title: 'A', tags: ['red'] })
      .expect(201);
    const first = await t.http.get(`${API}/notes/tags`).set(me.auth).expect(200);
    expect(first.body.data).toEqual([{ tag: 'red', count: 1 }]);
    await t.http
      .post(`${API}/notes`)
      .set(me.auth)
      .send({ title: 'B', tags: ['red', 'blue'] })
      .expect(201);
    await eventually(async () => {
      const res = await t.http.get(`${API}/notes/tags`).set(me.auth);
      return res.body.data[0]?.count === 2;
    });
  });

  describe('reminders (wall-clock input, cron → queue → processor → push)', () => {
    it('stores the instant and the zone, and refuses times in the past or skipped by daylight saving', async () => {
      const me = await signUp(t.http);
      // 20:00 in Dubai (UTC+4) is 16:00 UTC.
      const res = await t.http
        .post(`${API}/notes`)
        .set(me.auth)
        .send({ title: 'Call mum', reminder: { date: '2026-10-26', time: '20:00', timeZone: 'Asia/Dubai' } })
        .expect(201);
      expect(res.body.data.reminder).toEqual({
        remindAt: '2026-10-26T16:00:00.000Z',
        date: '2026-10-26',
        time: '20:00',
        timeZone: 'Asia/Dubai',
        sent: false,
      });

      const past = await t.http
        .post(`${API}/notes`)
        .set(me.auth)
        .send({ title: 'Too late', reminder: { date: '2026-10-26', time: '09:00', timeZone: 'Asia/Dubai' } })
        .expect(400);
      expect(past.body).toMatchObject({ error: 'REMINDER_IN_PAST', details: [{ field: 'reminder.time' }] });

      const skipped = await t.http
        .post(`${API}/notes`)
        .set(me.auth)
        .send({ title: 'DST', reminder: { date: '2027-03-14', time: '02:30', timeZone: 'America/New_York' } })
        .expect(400);
      expect(skipped.body.details).toEqual([
        {
          field: 'reminder.time',
          message: "Time doesn't exist on that day in that time zone because the clocks change. Choose another time.",
        },
      ]);
    });

    it('sends a due reminder once, as a push, however often the cron runs', async () => {
      const me = await signUp(t.http, { device: { pushToken: 'token-reminder', platform: 'ios' } });
      const note = (
        await t.http
          .post(`${API}/notes`)
          .set(me.auth)
          .send({ title: 'Stand-up', reminder: { date: '2026-10-26', time: '13:00', timeZone: 'Asia/Dubai' } })
          .expect(201)
      ).body.data;

      const cron = t.app.get(NotesCron);
      await cron.queueDueReminders();
      expect(t.fakes.push.sentTo('token-reminder')).toHaveLength(0);

      clock.set('2026-10-26T09:00:30Z');
      await cron.queueDueReminders();
      await cron.queueDueReminders();
      await eventually(async () => t.fakes.push.sentTo('token-reminder').length === 1);
      expect(t.fakes.push.sentTo('token-reminder')[0]).toMatchObject({
        title: 'Reminder: Stand-up',
        data: { noteId: note._id },
      });

      // A retried job finds the reminder claimed and sends nothing.
      await expect(t.app.get(NotesService).sendReminder(note._id, new Date('2026-10-26T09:00:00Z'))).resolves.toBe(
        false,
      );
      // Back before the access token's expiry to read the note over HTTP.
      clock.set('2026-10-26T08:00:00Z');
      const after = await t.http.get(`${V2}/notes/${note._id}`).set(me.auth).expect(200);
      expect(after.body.data.reminder.sent).toBe(true);
    });
  });

  it('purges notes deleted more than 30 days ago, not before', async () => {
    const me = await signUp(t.http);
    const note = (await t.http.post(`${API}/notes`).set(me.auth).send({ title: 'Old' }).expect(201)).body.data;
    await t.http.delete(`${API}/notes/${note._id}`).set(me.auth).expect(204);
    const notes = t.app.get(NotesService);
    await expect(notes.purgeDeleted()).resolves.toBe(0);
    clock.advance(31 * 86_400_000);
    await expect(notes.purgeDeleted()).resolves.toBeGreaterThanOrEqual(1);
    const raw = t.app.get<Connection>(getConnectionToken()).collection('notes');
    expect(await raw.countDocuments({ title: 'Old' })).toBe(0);
    clock.set('2026-10-26T08:00:00Z');
  });

  it('answers 410 on a v1 route after its sunset day', async () => {
    const me = await signUp(t.http);
    clock.set('2027-07-01T00:00:00Z');
    try {
      const res = await t.http.get(`${API}/notes`).set(me.auth);
      // The access token was issued before the jump; the route retires before auth matters.
      expect([401, 410]).toContain(res.status);
      const fresh = await signUp(t.http);
      const retired = await t.http.get(`${API}/notes`).set(fresh.auth).expect(410);
      expect(retired.body.error).toBe('ENDPOINT_RETIRED');
      await t.http.get(`${V2}/notes`).set(fresh.auth).expect(200);
    } finally {
      clock.set('2026-10-26T08:00:00Z');
    }
  });
});
