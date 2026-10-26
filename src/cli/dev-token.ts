import '@/common/time/force-utc';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@/common/auth/auth.types';
import { requireEnv } from './load-env';

/**
 * Prints an access token for local testing (curl, Postman, socket clients) until the real
 * auth module exists. Refuses to run in production.
 *
 *   node dist/cli/dev-token.js <userId> [user|admin|super_admin]
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('dev-token is disabled in production');

  const [userId = '000000000000000000000001', role = Role.USER] = process.argv.slice(2);
  if (!Object.values(Role).includes(role as Role)) {
    throw new Error(`role must be one of ${Object.values(Role).join(', ')}`);
  }

  const token = await new JwtService().signAsync(
    { sub: userId, role },
    { secret: requireEnv('JWT_ACCESS_SECRET'), expiresIn: '12h' },
  );
  console.log(token);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
