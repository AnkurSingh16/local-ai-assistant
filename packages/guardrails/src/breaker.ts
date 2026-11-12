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
  /**
   * How long a probe may run before it counts as failed. A provider that never
   * settles would otherwise hold the breaker half-open until restart. Set it
   * above the longest check.
   */
  readonly probeLeaseMs?: number;
}

export function createCircuitBreaker(config: BreakerConfig): CircuitBreaker {
  const threshold = config.failureThreshold ?? 5;
  const openMs = config.openMs ?? 10_000;
  const probeLeaseMs = config.probeLeaseMs ?? 30_000;
  const state: {
    failures: number;
    openedAt: number | undefined;
    probeStartedAt: number | undefined;
    probeId: number;
  } = { failures: 0, openedAt: undefined, probeStartedAt: undefined, probeId: 0 };

  const open = (): void => {
    state.openedAt = config.clock.monotonicMs();
    state.failures = 0;
  };

  return {
    acquire(): BreakerPermit | undefined {
      let probeId: number | undefined;
      if (state.openedAt !== undefined) {
        const now = config.clock.monotonicMs();
        if (state.probeStartedAt !== undefined && now - state.probeStartedAt >= probeLeaseMs) {
          // The probe overran its lease: count it as failed and start a new pause.
          state.probeStartedAt = undefined;
          state.probeId += 1;
          open();
          return undefined;
        }
        if (now - state.openedAt < openMs || state.probeStartedAt !== undefined) return undefined;
        state.probeStartedAt = now;
        state.probeId += 1;
        probeId = state.probeId;
      }
      const isProbe = probeId !== undefined;
      let settled = false;
      const settle = (apply: () => void): void => {
        if (settled) return;
        settled = true;
        if (isProbe) {
          // A probe whose lease already ran out has been counted; ignore its late result.
          if (probeId !== state.probeId) return;
          state.probeStartedAt = undefined;
        }
        apply();
      };
      return {
        // Any check that reached the guard shows it answering, even one started
        // before the breaker opened, so a success always closes it.
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
