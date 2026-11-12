/**
 * Time is injected rather than read from globals so that anything time-dependent
 * (cache expiry, rate limits, "what is today's date" answers, timeouts) can be
 * tested deterministically.
 */
export interface Clock {
  /** Wall-clock time, used for timestamps shown to users and stored records. */
  now(): Date;
  /**
   * Monotonic milliseconds, used for measuring durations. It never jumps backwards
   * when the system clock is adjusted, which wall-clock time can.
   */
  monotonicMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
};

export interface ManualClock extends Clock {
  /** Moves both wall-clock and monotonic time forward. */
  advance(ms: number): void;
  /** Jumps wall-clock time only, the way an NTP correction would. */
  setWallClock(date: Date): void;
}

export function createManualClock(start: Date): ManualClock {
  let wallMs = start.getTime();
  let monoMs = 0;
  return {
    now: () => new Date(wallMs),
    monotonicMs: () => monoMs,
    advance(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError(
          `advance() needs a finite, non-negative number of ms; got ${String(ms)}`,
        );
      }
      wallMs += ms;
      monoMs += ms;
    },
    setWallClock(date: Date): void {
      wallMs = date.getTime();
    },
  };
}
