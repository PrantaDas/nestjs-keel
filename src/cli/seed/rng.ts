/**
 * Deterministic pseudo-random numbers (mulberry32). `fork(key)` derives an independent stream from
 * a string, so work that runs concurrently draws the same numbers whatever the execution order.
 */
export class Rng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error('[seed] pick from an empty list');
    return items[Math.floor(this.next() * items.length)];
  }

  /** `[value, weight]` pairs; weights need not sum to 1. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1][0];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, Math.max(0, Math.min(count, items.length)));
  }

  /** Lower-case hex string of `length` characters. */
  hex(length: number): string {
    let out = '';
    while (out.length < length) out += this.int(0, 0xffff).toString(16).padStart(4, '0');
    return out.slice(0, length);
  }

  /** An independent stream for `key` (same seed + key = same numbers). */
  fork(key: string): Rng {
    return new Rng(hash32(`${this.seed}:${key}`));
  }
}

/** FNV-1a, 32 bits. */
export function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
