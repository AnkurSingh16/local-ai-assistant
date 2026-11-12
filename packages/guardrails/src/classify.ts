import type { HazardCategory, ModerationInput, ModerationProvider } from '@local-ai/core';
import { isAbortError } from '@local-ai/core';
import type { RefusalKind } from '@local-ai/contract';

/** S11 is self-harm in the llama-guard3 taxonomy; it gets care, not a refusal. */
const selfHarm: HazardCategory = 'S11';

export type ClassifyOutcome =
  { readonly ok: true } | { readonly ok: false; readonly refusal: RefusalKind };

/**
 * Runs the moderation provider under its own timeout and fails closed: any
 * error or timeout becomes `unavailable`. Only the caller's own abort is
 * rethrown, so a cancelled turn is not reported as a guard outage.
 */
export async function classifyOrRefuse(
  moderation: ModerationProvider,
  input: ModerationInput,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ClassifyOutcome> {
  try {
    const verdict = await moderation.classify(
      input,
      AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    );
    if (!verdict.flagged) return { ok: true };
    return { ok: false, refusal: verdict.categories.includes(selfHarm) ? 'self_harm' : 'policy' };
  } catch (err) {
    if (signal.aborted && isAbortError(err)) throw err;
    return { ok: false, refusal: 'unavailable' };
  }
}
