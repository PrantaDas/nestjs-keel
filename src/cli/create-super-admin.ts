import '@/common/time/force-utc';
import '@/config/load-env';
import { NestFactory } from '@nestjs/core';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { Role } from '@/common/auth/auth.types';
import { UsersRepository } from '@/modules/identity/users/users.repository';
import { UsersService } from '@/modules/identity/users/users.service';
import { CliModule } from './cli.module';

const USAGE = `
Usage: pnpm admin:create --email <email> [--name "<name>"] [--generate]

Creates a super admin, or promotes the existing account with that e-mail. The password is typed
(hidden) twice, or generated with --generate and printed once. It is never a flag, never logged,
and there is no default password anywhere in the codebase.
`;

/** Reads a line without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const writer = rl as unknown as { _writeToOutput: (text: string) => void };
    let muted = false;
    writer._writeToOutput = (text: string) => {
      if (!muted) process.stdout.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function readPassword(generate: boolean): Promise<string> {
  if (generate) return randomBytes(18).toString('base64url');
  const first = await promptHidden('Password (10+ characters, a letter and a number): ');
  const second = await promptHidden('Repeat the password: ');
  if (first !== second) throw new Error('The passwords do not match.');
  if (first.length < 10 || !/[A-Za-z]/.test(first) || !/\d/.test(first)) {
    throw new Error('The password needs at least 10 characters, with a letter and a number.');
  }
  return first;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      generate: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.email) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const email = values.email.trim().toLowerCase();
  const password = await readPassword(Boolean(values.generate));

  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
  try {
    const users = app.get(UsersService);
    const repository = app.get(UsersRepository);
    const existing = await repository.findByEmail(email);
    if (existing) {
      await repository.updateById(existing._id, {
        $set: { role: Role.SUPER_ADMIN, status: 'active', deactivatedBy: null },
      });
      await users.setPassword(existing._id.toHexString(), password);
      console.log(`Promoted ${email} to super admin and set a new password (id ${existing._id.toHexString()}).`);
    } else {
      const created = await users.create({
        name: values.name ?? 'Super admin',
        email,
        password,
        role: Role.SUPER_ADMIN,
        emailVerified: true,
      });
      console.log(`Created super admin ${email} (id ${created._id.toHexString()}).`);
    }
    if (values.generate) console.log(`Generated password (shown once, store it now): ${password}`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
