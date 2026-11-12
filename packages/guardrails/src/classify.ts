import type { HazardCategory, ModerationInput, ModerationProvider } from '@local-ai/core';
import { isAbortError } from '@local-ai/core';
import type { RefusalKind } from '@local-ai/contract';

import type { CircuitBreaker } from './breaker.js';

/** S11 is self-harm in the llama-guard3 taxonomy; it gets care, not a refusal. */
const selfHarm: HazardCategory = 'S11';

/** Asking Ollama which models are loaded is a local call; it must not eat the check's time. */
const residencyTimeoutMs = 500;

export interface GuardConfig {
  readonly moderation: ModerationProvider;
  /** Upper bound on a check that may need a model load (ADR-0005). */
  readonly timeoutMs: number;
  /**
   * Upper bound on a check when the provider reports the model already loaded.
   * Without it, or when residency is unknown, every check gets `timeoutMs`.
   */
  readonly warmTimeoutMs?: number;
  /** Shared by the input and output guards, so failures on either count together. */
  readonly breaker?: CircuitBreaker;
}

export type ClassifyOutcome =
  { readonly ok: true } | { readonly ok: false; readonly refusal: RefusalKind };

async function timeoutFor(config: GuardConfig, signal: AbortSignal): Promise<number> {
  if (config.warmTimeoutMs === undefined || config.moderation.isResident === undefined) {
    return config.timeoutMs;
  }
  try {
    const resident = await config.moderation.isResident(
      AbortSignal.any([signal, AbortSignal.timeout(residencyTimeoutMs)]),
    );
    return resident ? config.warmTimeoutMs : config.timeoutMs;
  } catch (err) {
    if (signal.aborted && isAbortError(err)) throw err;
    // Unknown residency gets the long timeout; the check itself still fails closed.
    return config.timeoutMs;
  }
}

/**
 * Runs the moderation provider under its own timeout and fails closed: any
 * error or timeout becomes `unavailable`, and so does an open circuit breaker.
 * Only the caller's own abort is rethrown, so a cancelled turn is not reported
 * as a guard outage or counted against the guard.
 */
export async function classifyOrRefuse(
  config: GuardConfig,
  input: ModerationInput,
  signal: AbortSignal,
): Promise<ClassifyOutcome> {
  const permit = config.breaker?.acquire();
  if (config.breaker !== undefined && permit === undefined) {
    return { ok: false, refusal: 'unavailable' };
  }
  try {
    const timeoutMs = await timeoutFor(config, signal);
    const verdict = await config.moderation.classify(
      input,
      AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    );
    permit?.success();
    if (!verdict.flagged) return { ok: true };
    return { ok: false, refusal: verdict.categories.includes(selfHarm) ? 'self_harm' : 'policy' };
  } catch (err) {
    if (signal.aborted && isAbortError(err)) {
      permit?.cancel();
      throw err;
    }
    permit?.failure();
    return { ok: false, refusal: 'unavailable' };
  }
}
