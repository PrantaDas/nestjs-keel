import { parseSeedArgs, resolveTarget, SeedRefusal } from './options';

describe('seed options and safety gates', () => {
  it('parses flags with defaults', () => {
    expect(parseSeedArgs([])).toEqual({ users: 50, seed: 1, reset: false, force: false, db: undefined });
    expect(parseSeedArgs(['--users', '200', '--seed', '7', '--reset', '--db', 'app_dev'])).toMatchObject({
      users: 200,
      seed: 7,
      reset: true,
      db: 'app_dev',
    });
    expect(() => parseSeedArgs(['--users', '1'])).toThrow(SeedRefusal);
    expect(() => parseSeedArgs(['--nope'])).toThrow(SeedRefusal);
  });

  it('refuses production, remote databases and non-disposable names', () => {
    const options = parseSeedArgs([]);
    expect(() => resolveTarget({ NODE_ENV: 'production', MONGO_URI: 'mongodb://localhost/app_dev' }, options)).toThrow(
      /production/,
    );
    expect(() => resolveTarget({ MONGO_URI: 'mongodb+srv://u:p@cluster.example.net/app_dev' }, options)).toThrow(
      /Refusing/,
    );
    expect(() => resolveTarget({ MONGO_URI: 'mongodb://localhost:27047/customers' }, options)).toThrow(
      /does not look disposable/,
    );
    expect(
      resolveTarget({ MONGO_URI: 'mongodb://localhost:27047/customers' }, { ...options, force: true }).dbName,
    ).toBe('customers');
  });

  it('applies --db and never prints credentials', () => {
    const target = resolveTarget(
      { MONGO_URI: 'mongodb://admin:secret@localhost:27047/app?directConnection=true' },
      parseSeedArgs(['--db', 'app_seed']),
    );
    expect(target.uri).toBe('mongodb://admin:secret@localhost:27047/app_seed?directConnection=true');
    expect(target.display).toBe('mongodb://***@localhost:27047/app_seed');
  });
});
