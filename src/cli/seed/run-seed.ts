import type { INestApplicationContext } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Role } from '@/common/auth/auth.types';
import { DeviceRegistry } from '@/common/contracts/device-registry.contract';
import type { MovableClock } from '@/common/time/clock';
import { TimeService } from '@/common/time/time.service';
import { NotesService } from '@/modules/examples/notes.service';
import { hashPassword } from '@/modules/identity/users/password';
import { UsersService } from '@/modules/identity/users/users.service';
import { FIRST_NAMES, LAST_NAMES, LOCALES, NOTE_BODIES, NOTE_TITLES, TAGS, TIME_ZONES } from './data';
import type { SeedOptions } from './options';
import { Rng } from './rng';

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 60;

export interface SeedSummary {
  staff: Array<{ role: Role; email: string; id: string }>;
  users: number;
  deactivated: number;
  deletionPending: number;
  notes: number;
  deletedNotes: number;
  reminders: number;
  /** Shown once at the end, stored nowhere but as a hash. */
  passwords: { staff: string; users: string };
  sampleUser: string;
}

/**
 * Writes a realistic local dataset through the real services (the same calls the controllers make),
 * so indexes, day keys, versions and events are what the app itself would produce. History is written
 * with the clock moved back (`MovableClock`): an account that joined 40 days ago has its createdAt,
 * and its notes their business day, from 40 days ago.
 */
export async function runSeed(
  app: INestApplicationContext,
  clock: MovableClock,
  options: SeedOptions,
): Promise<SeedSummary> {
  const users = app.get(UsersService);
  const notes = app.get(NotesService);
  const devices = app.get(DeviceRegistry);
  const time = app.get(TimeService);
  const rng = new Rng(options.seed);
  const now = time.now();
  const passwords = { staff: randomBytes(12).toString('base64url'), users: randomBytes(12).toString('base64url') };
  // One hash for every seeded person: scrypt is deliberately slow, thousands of them would take minutes.
  const usersHash = await hashPassword(passwords.users);

  const summary: SeedSummary = {
    staff: [],
    users: 0,
    deactivated: 0,
    deletionPending: 0,
    notes: 0,
    deletedNotes: 0,
    reminders: 0,
    passwords,
    sampleUser: '',
  };

  clock.travelTo(new Date(now.getTime() - HISTORY_DAYS * DAY_MS));
  for (const [role, email, name] of [
    [Role.SUPER_ADMIN, 'superadmin@example.com', 'Sam Super'],
    [Role.ADMIN, 'admin@example.com', 'Alex Admin'],
  ] as const) {
    const staff = await users.create({ name, email, password: passwords.staff, role, emailVerified: true });
    summary.staff.push({ role, email, id: staff._id.toHexString() });
  }

  for (let i = 0; i < options.users; i += 1) {
    const r = rng.fork(`user:${i}`);
    const first = r.pick(FIRST_NAMES);
    const last = r.pick(LAST_NAMES);
    // Joined over the last 60 days, more of them recently.
    const joinedAt = new Date(now.getTime() - Math.floor(HISTORY_DAYS * DAY_MS * r.next() ** 2));
    clock.travelTo(joinedAt);
    const email =
      `${first}.${last}.${i}`
        .normalize('NFKD')
        .replace(/[^\w.]/g, '')
        .toLowerCase() + '@example.com';
    const user = await users.create({
      name: `${first} ${last}`,
      email,
      passwordHash: usersHash,
      emailVerified: r.chance(0.8),
      // Fictional numbers: +1 (202) 555-01xx is reserved for fiction.
      phone: r.chance(0.3) && i < 100 ? `+120255501${String(i).padStart(2, '0')}` : null,
    });
    const userId = user._id.toHexString();
    if (i === 0) summary.sampleUser = email;
    await users.updateProfile(userId, { locale: r.pick(LOCALES), timeZone: r.pick(TIME_ZONES) });
    if (r.chance(0.7)) {
      await devices.register(userId, {
        token: `seed-${r.hex(32)}`,
        platform: r.weighted([
          ['android', 5],
          ['ios', 4],
          ['web', 1],
        ] as const),
        appVersion: `1.${r.int(0, 9)}.${r.int(0, 20)}`,
      });
    }

    const noteCount = r.weighted([
      [0, 1],
      [2, 3],
      [5, 3],
      [10, 1],
    ] as const);
    for (let n = 0; n < noteCount; n += 1) {
      const nr = r.fork(`note:${n}`);
      clock.travelTo(new Date(joinedAt.getTime() + Math.floor((now.getTime() - joinedAt.getTime()) * nr.next())));
      const note = await notes.create(userId, {
        title: nr.pick(NOTE_TITLES),
        body: nr.pick(NOTE_BODIES),
        tags: nr.sample(TAGS, nr.int(0, 3)),
        pinned: nr.chance(0.15),
      });
      summary.notes += 1;
      if (nr.chance(0.1)) {
        await notes.remove(userId, note._id.toHexString());
        summary.deletedNotes += 1;
      }
    }

    // Back to the present for things that must lie in the future (reminders) or happen last.
    clock.reset();
    if (r.chance(0.2)) {
      const local = time.toLocal(
        new Date(now.getTime() + r.int(1, 14) * DAY_MS),
        user.timeZone ? (user.timeZone as never) : time.businessZone,
      );
      await notes.create(userId, {
        title: 'Reminder: ' + r.pick(NOTE_TITLES),
        reminder: { ...local, time: '09:00' } as never,
      });
      summary.notes += 1;
      summary.reminders += 1;
    }
    if (i > 0 && r.chance(0.04)) {
      await users.deactivateSelf(userId, passwords.users);
      summary.deactivated += 1;
    } else if (i > 0 && r.chance(0.02)) {
      await users.requestDeletion({ id: userId, role: Role.USER, sessionId: 'seed' }, passwords.users);
      summary.deletionPending += 1;
    }
    summary.users += 1;
  }
  clock.reset();
  return summary;
}
