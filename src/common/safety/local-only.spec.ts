import { assertLocalMongoUri, isLocalMongoUri, mongoHosts } from './local-only';

describe('local-only database guard', () => {
  it.each([
    ['mongodb://localhost:27037/app'],
    ['mongodb://127.0.0.1:27017/app?directConnection=true'],
    ['mongodb://user:pass@localhost:27037/app'],
    ['mongodb://mongo:27017/app'],
  ])('accepts %s', (uri) => {
    expect(isLocalMongoUri(uri)).toBe(true);
    expect(() => assertLocalMongoUri(uri, 'e2e tests')).not.toThrow();
  });

  it.each([
    ['mongodb+srv://user:pass@cluster0.example.mongodb.net/app-v5-1'],
    ['mongodb://cluster0.example.net:27017/app'],
    ['mongodb://10.0.0.5:27017/app'],
    // One remote host among local ones is still remote.
    ['mongodb://localhost:27017,shard.example.net:27017/app'],
  ])('refuses %s', (uri) => {
    expect(isLocalMongoUri(uri)).toBe(false);
    expect(() => assertLocalMongoUri(uri, 'e2e tests')).toThrow(/Refusing to run e2e tests/);
  });

  it('never names credentials in the message, and mentions the escape hatch when there is one', () => {
    const uri = 'mongodb://admin:hunter2@cluster0.example.net:27017/app';
    expect(() => assertLocalMongoUri(uri, 'pnpm seed', '--force')).toThrow(/--force/);
    try {
      assertLocalMongoUri(uri, 'pnpm seed', '--force');
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
      expect((err as Error).message).not.toContain('admin');
    }
  });

  it('reads the hosts of a URI without its credentials', () => {
    expect(mongoHosts('mongodb://user:p@ss@a.example.net:27017,b.example.net:27018/db')).toEqual([
      'a.example.net',
      'b.example.net',
    ]);
  });
});
