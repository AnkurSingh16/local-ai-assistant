import type { Clock } from '@local-ai/core';

/**
 * A circuit breaker for the guard (ADR-0005). After a run of failed checks the
 * guard is probably down or overloaded, so further checks refuse at once with
 * `unavailable` instead of each waiting out its timeout. After a pause one probe
 * is let through; its result closes the breaker or opens it again.
 */
export interface CircuitBreaker {
  /** A permit to run one check, or undefined while the breaker is open. */
  acquire(): BreakerPermit | undefined;
}

export interface BreakerPermit {
  /** The guard answered, whatever the verdict. */
  success(): void;
  /** The guard errored or timed out. */
  failure(): void;
  /** The caller gave up; the check says nothing about the guard. */
  cancel(): void;
}

export interface BreakerConfig {
  readonly clock: Clock;
  readonly failureThreshold?: number;
  readonly openMs?: number;
}

export function createCircuitBreaker(config: BreakerConfig): CircuitBreaker {
  const threshold = config.failureThreshold ?? 5;
  const openMs = config.openMs ?? 10_000;
  const state: { failures: number; openedAt: number | undefined; probing: boolean } = {
    failures: 0,
    openedAt: undefined,
    probing: false,
  };

  const open = (): void => {
    state.openedAt = config.clock.monotonicMs();
    state.failures = 0;
  };

  return {
    acquire(): BreakerPermit | undefined {
      let isProbe = false;
      if (state.openedAt !== undefined) {
        const waited = config.clock.monotonicMs() - state.openedAt;
        if (waited < openMs || state.probing) return undefined;
        state.probing = true;
        isProbe = true;
      }
      let settled = false;
      const settle = (apply: () => void): void => {
        if (settled) return;
        settled = true;
        if (isProbe) state.probing = false;
        apply();
      };
      return {
        success: () => {
          settle(() => {
            state.failures = 0;
            state.openedAt = undefined;
          });
        },
        failure: () => {
          settle(() => {
            if (isProbe) {
              open();
              return;
            }
            // A check started before the breaker opened says nothing new.
            if (state.openedAt !== undefined) return;
            state.failures += 1;
            if (state.failures >= threshold) open();
          });
        },
        cancel: () => {
          settle(() => undefined);
        },
      };
    },
  };
}
