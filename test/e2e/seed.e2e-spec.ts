import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Clock, MovableClock } from '@/common/time/clock';
import { runSeed } from '@/cli/seed/run-seed';
import { createTestApp, TestApp } from './app';
import { API } from './helpers';

/** The seed writes believable data through the real services, deterministically per seed. */
describe('Seed (e2e)', () => {
  const clock = new MovableClock();
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ configure: (builder) => builder.overrideProvider(Clock).useValue(clock) });
  });

  afterAll(() => t.close());

  it('creates staff, people and their notes with history, and the printed passwords work', async () => {
    const summary = await runSeed(t.app, clock, { users: 12, seed: 3, reset: false, force: false });
    const db = t.app.get<Connection>(getConnectionToken());
    expect(await db.collection('users').countDocuments({ role: 'user' })).toBe(12);
    expect(summary.notes).toBeGreaterThan(0);
    // History: the oldest account joined weeks ago, with notes dated in between.
    const oldest = await db.collection('users').find({ role: 'user' }).sort({ createdAt: 1 }).limit(1).next();
    expect(Date.now() - (oldest!.createdAt as Date).getTime()).toBeGreaterThan(86_400_000);

    await t.http
      .post(`${API}/auth/login`)
      .send({ email: 'superadmin@example.com', password: summary.passwords.staff })
      .expect(200);
    const sample = await db.collection('users').findOne({ email: summary.sampleUser });
    if (sample?.status === 'active') {
      await t.http
        .post(`${API}/auth/login`)
        .send({ email: summary.sampleUser, password: summary.passwords.users })
        .expect(200);
    }
  });

  it('draws the same people for the same seed', async () => {
    const db = t.app.get<Connection>(getConnectionToken());
    const names = async () =>
      (
        await db
          .collection('users')
          .find({ role: 'user' }, { sort: { email: 1 } })
          .toArray()
      ).map((u) => u.name as string);
    const first = await names();
    await db.dropDatabase();
    await db.syncIndexes();
    await runSeed(t.app, clock, { users: 12, seed: 3, reset: false, force: false });
    expect(await names()).toEqual(first);
  });
});
