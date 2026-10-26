import { RateGate } from './rate-gate';

describe('RateGate', () => {
  it('passes one event per key per window and counts the suppressed ones', () => {
    let now = 0;
    const gate = new RateGate(1000, () => now);

    expect(gate.pass('mongodb')).toEqual({ pass: true, suppressed: 0 });
    expect(gate.pass('mongodb').pass).toBe(false);
    expect(gate.pass('mongodb')).toEqual({ pass: false, suppressed: 2 });
    expect(gate.pass('redis').pass).toBe(true);

    now = 1000;
    expect(gate.pass('mongodb')).toEqual({ pass: true, suppressed: 2 });
  });

  it('lets the next event through after a reset', () => {
    const gate = new RateGate(60_000, () => 0);
    gate.pass('k');
    gate.reset('k');
    expect(gate.pass('k').pass).toBe(true);
  });
});
