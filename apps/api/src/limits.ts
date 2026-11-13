import type { Clock } from '@local-ai/core';
import type { FastifyRateLimitStore, FastifyRateLimitStoreCtor } from '@fastify/rate-limit';

/**
 * A fixed-window rate-limit store driven by the injected Clock, so limits are
 * tested by advancing time instead of sleeping (ADR-0011). State lives in
 * memory and resets on restart, which is acceptable for one process.
 */
export function createClockStore(clock: Clock): FastifyRateLimitStoreCtor {
  return class ClockStore implements FastifyRateLimitStore {
    private readonly windows = new Map<string, { count: number; resetAt: number }>();

    incr(
      key: string,
      callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
      timeWindow: number,
    ): void {
      const now = clock.monotonicMs();
      if (this.windows.size > 10_000) {
        for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
      }
      let w = this.windows.get(key);
      if (w === undefined || w.resetAt <= now) {
        w = { count: 0, resetAt: now + timeWindow };
        this.windows.set(key, w);
      }
      w.count++;
      callback(null, { current: w.count, ttl: w.resetAt - now });
    }

    child(): FastifyRateLimitStore {
      return new ClockStore();
    }
  };
}

export interface TurnSlots {
  /**
   * Waits for a turn slot. Resolves with a release function, or with
   * `undefined` when the queue is full. Rejects if the signal aborts while
   * queued.
   */
  acquire(signal: AbortSignal): Promise<(() => void) | undefined>;
  readonly active: number;
  readonly queued: number;
}

/**
 * The global cap: a few concurrent turns and a short queue (ADR-0011). Ollama
 * runs one generation at a time, so more concurrency would only add waiting.
 */
export function createTurnSlots(maxActive: number, maxQueued: number): TurnSlots {
  let active = 0;
  const queue: (() => void)[] = [];

  const release = (): void => {
    const next = queue.shift();
    if (next === undefined) active--;
    else next();
  };
  const once = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };

  return {
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
    acquire(signal: AbortSignal): Promise<(() => void) | undefined> {
      signal.throwIfAborted();
      if (active < maxActive) {
        active++;
        return Promise.resolve(once());
      }
      if (queue.length >= maxQueued) return Promise.resolve(undefined);
      return new Promise((resolve, reject) => {
        const grant = (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve(once());
        };
        const onAbort = (): void => {
          const i = queue.indexOf(grant);
          if (i !== -1) queue.splice(i, 1);
          reject(new DOMException('The turn was cancelled while queued.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        queue.push(grant);
      });
    },
  };
}

/** A fixed-window counter per key on the injected clock: true while the key is within its limit. */
export interface WindowLimiter {
  /** Counts one request; returns the wait in ms when over the limit, or undefined. */
  hit(key: string): number | undefined;
}

export function createWindowLimiter(clock: Clock, max: number, windowMs: number): WindowLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key) {
      const now = clock.monotonicMs();
      if (windows.size > 10_000) {
        for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
      }
      let w = windows.get(key);
      if (w === undefined || w.resetAt <= now) {
        w = { count: 0, resetAt: now + windowMs };
        windows.set(key, w);
      }
      w.count++;
      return w.count > max ? w.resetAt - now : undefined;
    },
  };
}
