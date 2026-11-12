import { createManualClock } from '@local-ai/core';
import { createMockModerationProvider } from '@local-ai/providers/mock';
import { describe, expect, it } from 'vitest';

import { createCircuitBreaker } from './breaker.js';
import { createInputGuard } from './input.js';
import { createOutputGuard } from './output.js';

const start = new Date('2026-11-12T00:00:00Z');

function failTimes(breaker: ReturnType<typeof createCircuitBreaker>, n: number): void {
  for (let i = 0; i < n; i++) breaker.acquire()?.failure();
}

describe('circuit breaker', () => {
  it('opens after five consecutive failures and stays open for ten seconds', () => {
    const clock = createManualClock(start);
    const breaker = createCircuitBreaker({ clock });
    failTimes(breaker, 4);
    expect(breaker.acquire()).toBeDefined();
    failTimes(breaker, 1);
    expect(breaker.acquire()).toBeUndefined();
    clock.advance(9_999);
    expect(breaker.acquire()).toBeUndefined();
  });

  it('a success resets the count', () => {
    const breaker = createCircuitBreaker({ clock: createManualClock(start) });
    failTimes(breaker, 4);
    breaker.acquire()?.success();
    failTimes(breaker, 4);
    expect(breaker.acquire()).toBeDefined();
  });

  it('lets exactly one probe through after the pause; its success closes the breaker', () => {
    const clock = createManualClock(start);
    const breaker = createCircuitBreaker({ clock });
    failTimes(breaker, 5);
    clock.advance(10_000);
    const probe = breaker.acquire();
    expect(probe).toBeDefined();
    expect(breaker.acquire()).toBeUndefined();
    probe?.success();
    expect(breaker.acquire()).toBeDefined();
  });

  it('a failed probe opens the breaker for another pause', () => {
    const clock = createManualClock(start);
    const breaker = createCircuitBreaker({ clock });
    failTimes(breaker, 5);
    clock.advance(10_000);
    breaker.acquire()?.failure();
    expect(breaker.acquire()).toBeUndefined();
    clock.advance(10_000);
    expect(breaker.acquire()).toBeDefined();
  });

  it('a cancelled probe frees the slot without closing or reopening', () => {
    const clock = createManualClock(start);
    const breaker = createCircuitBreaker({ clock });
    failTimes(breaker, 5);
    clock.advance(10_000);
    breaker.acquire()?.cancel();
    const next = breaker.acquire();
    expect(next).toBeDefined();
    expect(breaker.acquire()).toBeUndefined();
  });

  it('counts a probe that overruns its lease as failed, and ignores its late result', () => {
    const clock = createManualClock(start);
    const breaker = createCircuitBreaker({ clock, failureThreshold: 1, probeLeaseMs: 5_000 });
    failTimes(breaker, 1);
    clock.advance(10_000);
    const stuck = breaker.acquire();
    expect(stuck).toBeDefined();
    clock.advance(5_000);
    expect(breaker.acquire()).toBeUndefined(); // lease expired: reopened from now
    stuck?.success();
    expect(breaker.acquire()).toBeUndefined();
    clock.advance(10_000);
    expect(breaker.acquire()).toBeDefined();
  });

  it('ignores late failures from checks that started before it opened, and repeat settles', () => {
    const clock = createManualClock(start);
    const breaker = createCircuitBreaker({ clock, failureThreshold: 2 });
    const early = breaker.acquire();
    failTimes(breaker, 2);
    clock.advance(9_000);
    early?.failure();
    early?.failure();
    clock.advance(1_000);
    expect(breaker.acquire()).toBeDefined();
  });
});

describe('guards with the breaker and warm timeout', () => {
  const signal = new AbortController().signal;

  it('refuses with unavailable without calling the guard while open, across both guards', async () => {
    const clock = createManualClock(start);
    const breaker = createCircuitBreaker({ clock, failureThreshold: 2 });
    const failing = createMockModerationProvider({
      classify: () => {
        throw new Error('down');
      },
    });
    const config = { moderation: failing, timeoutMs: 1000, breaker };
    const input = createInputGuard(config);
    const output = createOutputGuard(config);
    expect(await input.check('hi', signal)).toEqual({ ok: false, refusal: 'unavailable' });
    expect(await output.checkParagraph('para', signal)).toEqual({
      ok: false,
      refusal: 'unavailable',
    });
    expect(failing.calls).toHaveLength(2);
    expect(await input.check('hi', signal)).toEqual({ ok: false, refusal: 'unavailable' });
    expect(failing.calls).toHaveLength(2);
  });

  it('counts a flagged verdict as the guard working', async () => {
    const breaker = createCircuitBreaker({ clock: createManualClock(start), failureThreshold: 1 });
    const guard = createInputGuard({
      moderation: createMockModerationProvider(),
      timeoutMs: 1000,
      breaker,
    });
    expect(await guard.check('MOCK_FLAG', signal)).toEqual({ ok: false, refusal: 'policy' });
    expect(breaker.acquire()).toBeDefined();
  });

  it('does not count the caller abort against the guard', async () => {
    const breaker = createCircuitBreaker({ clock: createManualClock(start), failureThreshold: 1 });
    const guard = createInputGuard({
      moderation: createMockModerationProvider({ delayMs: 200 }),
      timeoutMs: 1000,
      breaker,
    });
    const controller = new AbortController();
    const pending = guard.check('hi', controller.signal).catch(() => undefined);
    controller.abort();
    await pending;
    expect(breaker.acquire()).toBeDefined();
  });

  it('treats any abort of the caller signal as a cancel, whatever its reason', async () => {
    const breaker = createCircuitBreaker({ clock: createManualClock(start), failureThreshold: 1 });
    const guard = createInputGuard({
      moderation: createMockModerationProvider({ delayMs: 200 }),
      timeoutMs: 1000,
      breaker,
    });
    const controller = new AbortController();
    const pending = guard.check('hi', controller.signal).catch((e: unknown) => e);
    controller.abort(new Error('client gone'));
    expect(await pending).toBeInstanceOf(Error);
    expect(breaker.acquire()).toBeDefined();
  });

  it('cancels, not fails, when the caller aborts during the residency read', async () => {
    const breaker = createCircuitBreaker({ clock: createManualClock(start), failureThreshold: 1 });
    const moderation = {
      ...createMockModerationProvider(),
      isResident: (s: AbortSignal): Promise<boolean> =>
        new Promise((_, reject) => {
          s.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    };
    const guard = createInputGuard({ moderation, timeoutMs: 1000, warmTimeoutMs: 20, breaker });
    const controller = new AbortController();
    const pending = guard.check('hi', controller.signal).catch(() => 'aborted');
    controller.abort();
    expect(await pending).toBe('aborted');
    expect(breaker.acquire()).toBeDefined();
  });

  it('falls back to the long timeout when the residency read hangs', async () => {
    const moderation = {
      ...createMockModerationProvider({ delayMs: 50 }),
      isResident: (s: AbortSignal): Promise<boolean> =>
        new Promise((_, reject) => {
          s.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    };
    const guard = createInputGuard({ moderation, timeoutMs: 2000, warmTimeoutMs: 10 });
    expect(await guard.check('hi', signal)).toEqual({ ok: true, text: 'hi' });
  });

  it('refuses at the deadline even if the provider ignores its signal', async () => {
    const moderation = {
      ...createMockModerationProvider(),
      classify: (): Promise<never> => new Promise(() => undefined),
    };
    const guard = createInputGuard({ moderation, timeoutMs: 30 });
    expect(await guard.check('hi', signal)).toEqual({ ok: false, refusal: 'unavailable' });
  });

  it('uses the short timeout only when the guard is resident', async () => {
    const config = { timeoutMs: 1000, warmTimeoutMs: 20 };
    const warm = createInputGuard({
      ...config,
      moderation: createMockModerationProvider({ delayMs: 100, resident: true }),
    });
    expect(await warm.check('hi', signal)).toEqual({ ok: false, refusal: 'unavailable' });
    const cold = createInputGuard({
      ...config,
      moderation: createMockModerationProvider({ delayMs: 100, resident: false }),
    });
    expect(await cold.check('hi', signal)).toEqual({ ok: true, text: 'hi' });
  });

  it('falls back to the long timeout when residency cannot be read', async () => {
    const moderation = createMockModerationProvider({
      delayMs: 100,
      resident: () => {
        throw new Error('ps failed');
      },
    });
    const guard = createInputGuard({ moderation, timeoutMs: 1000, warmTimeoutMs: 20 });
    expect(await guard.check('hi', signal)).toEqual({ ok: true, text: 'hi' });
  });
});
