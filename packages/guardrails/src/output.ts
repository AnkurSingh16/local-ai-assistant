import type { ModeratedText } from '@local-ai/core';
import type { RefusalKind } from '@local-ai/contract';

import { classifyOrRefuse } from './classify.js';
import type { GuardConfig } from './classify.js';
import { mintModerated } from './mint.js';

export type OutputVerdict =
  | { readonly ok: true; readonly text: ModeratedText }
  | { readonly ok: false; readonly refusal: RefusalKind };

export interface OutputGuard {
  checkParagraph(text: string, signal: AbortSignal): Promise<OutputVerdict>;
}

/** Classifies one held-back paragraph of the answer before it is released (ADR-0005). */
export function createOutputGuard(config: GuardConfig): OutputGuard {
  return {
    async checkParagraph(text: string, signal: AbortSignal): Promise<OutputVerdict> {
      const outcome = await classifyOrRefuse(config, { role: 'assistant', text }, signal);
      return outcome.ok ? { ok: true, text: mintModerated(text) } : outcome;
    },
  };
}
