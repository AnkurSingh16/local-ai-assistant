import { createManualClock } from '@local-ai/core';
import { describe, expect, it } from 'vitest';

import { createClockStore, createTurnSlots } from './limits.js';

describe('clock-backed rate-limit store', () => {
  it('counts within a window and resets when it ends', () => {
    const clock = createManualClock(new Date(0));
    const Store = createClockStore(clock);
    const store = new Store({});
    const results: { current: number; ttl: number }[] = [];
    const incr = (): void => {
      store.incr('k', (_e, r) => r && results.push(r), 1000, 10);
    };
    incr();
    clock.advance(400);
    incr();
    clock.advance(600);
    incr();
    expect(results).toEqual([
      { current: 1, ttl: 1000 },
      { current: 2, ttl: 600 },
      { current: 1, ttl: 1000 },
    ]);
  });
});

describe('turn slots', () => {
  it('admits up to the cap, queues up to the limit, then refuses', async () => {
    const slots = createTurnSlots(1, 1);
    const signal = new AbortController().signal;
    const first = await slots.acquire(signal);
    const queued = slots.acquire(signal);
    expect(await slots.acquire(signal)).toBeUndefined();
    expect(slots.queued).toBe(1);
    first?.();
    first?.(); // releasing twice has no extra effect
    const second = await queued;
    expect(slots.active).toBe(1);
    second?.();
    expect(slots.active).toBe(0);
  });

  it('drops a queued turn whose client aborts', async () => {
    const slots = createTurnSlots(1, 1);
    const first = await slots.acquire(new AbortController().signal);
    const controller = new AbortController();
    const queued = slots.acquire(controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow();
    expect(slots.queued).toBe(0);
    first?.();
    expect(slots.active).toBe(0);
  });
});
