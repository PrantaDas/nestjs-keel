import { stripDangerousKeys } from './sanitize-input.middleware';

describe('stripDangerousKeys', () => {
  it('removes operator and dotted keys at any depth, keeps the rest', () => {
    const input = {
      email: { $gt: '' },
      name: 'Ada',
      nested: { ok: 1, 'a.b': 2, list: [{ $where: 'sleep(1)', fine: true }] },
      ['__proto__']: { admin: true },
    };
    expect(stripDangerousKeys(input)).toEqual({ email: {}, name: 'Ada', nested: { ok: 1, list: [{ fine: true }] } });
  });

  it('leaves primitives, buffers and null alone', () => {
    const buffer = Buffer.from('{}');
    expect(stripDangerousKeys('x')).toBe('x');
    expect(stripDangerousKeys(null)).toBeNull();
    expect(stripDangerousKeys(buffer)).toBe(buffer);
  });
});
