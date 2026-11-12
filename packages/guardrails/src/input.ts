import type { ModeratedText } from '@local-ai/core';
import type { RefusalKind } from '@local-ai/contract';
import { maxMessageChars } from '@local-ai/contract';

import type { GuardConfig } from './classify.js';
import { classifyOrRefuse } from './classify.js';
import { mintModerated } from './mint.js';
import { normalise } from './normalise.js';

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
      const outcome = await classifyOrRefuse(config, { role: 'user', text: normalised }, signal);
      return outcome.ok ? { ok: true, text: mintModerated(normalised) } : outcome;
    },
  };
}
