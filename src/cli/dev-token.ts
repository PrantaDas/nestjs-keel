import '@/common/time/force-utc';
import '@/config/load-env';
import { NestFactory } from '@nestjs/core';
import { isValidObjectId } from 'mongoose';
import { SessionService } from '@/modules/identity/sessions/session.service';
import { UsersService } from '@/modules/identity/users/users.service';
import { CliModule } from './cli.module';

/**
 * Prints an access token for an existing account, for curl, Postman and socket clients. It opens a
 * real session (revocable like any other) for that account's current role. Refused in production.
 *
 *   pnpm dev:token <userId>
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('dev-token is disabled in production');
  const [userId] = process.argv.slice(2);
  if (!userId || !isValidObjectId(userId)) throw new Error('Usage: pnpm dev:token <userId>');

  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
  try {
    const user = await app.get(UsersService).findOrFail(userId);
    const pair = await app.get(SessionService).start({ userId, role: user.role, device: 'dev-token CLI', ip: null });
    console.log(pair.accessToken);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
