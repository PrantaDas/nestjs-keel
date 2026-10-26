import { Rng } from './rng';

describe('seed rng', () => {
  it('is deterministic per seed', () => {
    const draw = (seed: number) => {
      const rng = new Rng(seed);
      return Array.from({ length: 5 }, () => rng.int(0, 1000));
    };
    expect(draw(1)).toEqual(draw(1));
    expect(draw(1)).not.toEqual(draw(2));
  });

  it('forks independent streams by key, whatever was drawn before', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    b.next();
    b.next();
    expect(a.fork('person:3').next()).toBe(b.fork('person:3').next());
    expect(a.fork('person:3').next()).not.toBe(a.fork('person:4').next());
  });

  it('keeps numbers in range and samples without repeats', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 1000; i += 1) {
      const n = rng.int(3, 5);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
    }
    const sample = rng.sample([1, 2, 3, 4, 5, 6], 4);
    expect(new Set(sample).size).toBe(4);
    expect(rng.hex(12)).toMatch(/^[0-9a-f]{12}$/);
  });
});
