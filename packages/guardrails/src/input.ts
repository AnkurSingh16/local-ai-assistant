import type { ModeratedText, ModerationProvider } from '@local-ai/core';
import type { RefusalKind } from '@local-ai/contract';
import { maxMessageChars } from '@local-ai/contract';

import { classifyOrRefuse } from './classify.js';
import { mintModerated } from './mint.js';
import { normalise } from './normalise.js';

export interface GuardConfig {
  readonly moderation: ModerationProvider;
  /** Upper bound on one guard call. It covers a cold model load (ADR-0005). */
  readonly timeoutMs: number;
}

export type InputVerdict =
  | { readonly ok: true; readonly text: ModeratedText }
  | { readonly ok: false; readonly refusal: RefusalKind }
  | { readonly ok: false; readonly tooLong: true };

export interface InputGuard {
  check(text: string, signal: AbortSignal): Promise<InputVerdict>;
}

/**
 * The input stage: normalise, re-check the size (NFKC can lengthen text), then
 * classify. The text that passes is the normalised text, so what was checked is
 * exactly what reaches the model.
 */
export function createInputGuard(config: GuardConfig): InputGuard {
  return {
    async check(text: string, signal: AbortSignal): Promise<InputVerdict> {
      const normalised = normalise(text);
      if (normalised.length > maxMessageChars) return { ok: false, tooLong: true };
      const outcome = await classifyOrRefuse(
        config.moderation,
        { role: 'user', text: normalised },
        config.timeoutMs,
        signal,
      );
      return outcome.ok ? { ok: true, text: mintModerated(normalised) } : outcome;
    },
  };
}
