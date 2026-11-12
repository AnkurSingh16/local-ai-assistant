import { describe, expect, it } from 'vitest';
import { createManualClock, systemClock } from './clock.js';

describe('systemClock', () => {
  it('returns the current wall-clock time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('returns monotonic time that does not decrease', () => {
    const a = systemClock.monotonicMs();
    const b = systemClock.monotonicMs();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe('createManualClock', () => {
  const start = new Date('2026-01-01T00:00:00.000Z');

  it('starts at the given time with monotonic time at zero', () => {
    const clock = createManualClock(start);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(clock.monotonicMs()).toBe(0);
  });

  it('advances wall-clock and monotonic time together', () => {
    const clock = createManualClock(start);
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.500Z');
    expect(clock.monotonicMs()).toBe(1500);
  });

  it('lets wall-clock time jump backwards without affecting monotonic time', () => {
    const clock = createManualClock(start);
    clock.advance(10_000);
    clock.setWallClock(new Date('2025-12-31T23:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2025-12-31T23:00:00.000Z');
    expect(clock.monotonicMs()).toBe(10_000);
  });

  it('returns a fresh Date so callers cannot mutate the clock', () => {
    const clock = createManualClock(start);
    clock.now().setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects advance(%s)', (ms) => {
    const clock = createManualClock(start);
    expect(() => {
      clock.advance(ms);
    }).toThrow(RangeError);
  });
});
