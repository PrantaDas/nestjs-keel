import { decoyHash, hashPassword, needsRehash, verifyPassword } from './password';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$15$8$3$')).toBe(true);
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
    await expect(verifyPassword('Correct horse battery staple', hash)).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('treats malformed or missing hashes as a mismatch, never a crash', async () => {
    await expect(verifyPassword('x', null)).resolves.toBe(false);
    await expect(verifyPassword('x', 'bcrypt$whatever')).resolves.toBe(false);
  });

  it('flags hashes with old parameters for an upgrade', async () => {
    expect(needsRehash(await hashPassword('x'))).toBe(false);
    expect(needsRehash('scrypt$14$8$1$c2FsdA$aGFzaA')).toBe(true);
  });

  it('has a decoy hash for unknown accounts', async () => {
    await expect(verifyPassword('anything', await decoyHash())).resolves.toBe(false);
  });
});
