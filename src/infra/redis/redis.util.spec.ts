import { parseRedisUrl } from './redis.util';

describe('parseRedisUrl', () => {
  it('parses host, port, db and encoded credentials', () => {
    expect(parseRedisUrl('redis://default:p%40ss@cache.internal:6380/2')).toMatchObject({
      host: 'cache.internal',
      port: 6380,
      username: 'default',
      password: 'p@ss',
      db: 2,
      tls: undefined,
    });
  });

  it('enables TLS for rediss:// and applies overrides', () => {
    expect(parseRedisUrl('rediss://red-xyz.render.com', { maxRetriesPerRequest: null })).toMatchObject({
      port: 6379,
      db: 0,
      tls: {},
      maxRetriesPerRequest: null,
    });
  });
});
