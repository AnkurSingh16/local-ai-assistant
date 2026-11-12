import type { ModeratedText } from '@local-ai/core';
import type { RefusalKind } from '@local-ai/contract';

import { classifyOrRefuse } from './classify.js';
import type { GuardConfig } from './classify.js';
import { mintModerated } from './mint.js';
import type { OutputRules } from './rules/output.js';

export type OutputVerdict =
  | { readonly ok: true; readonly text: ModeratedText }
  | { readonly ok: false; readonly refusal: RefusalKind };

export interface OutputGuard {
  checkParagraph(text: string, signal: AbortSignal): Promise<OutputVerdict>;
}

export interface OutputGuardConfig extends GuardConfig {
  /**
   * The persona rules. Required, because they need the system prompt and there
   * is no safe default.
   */
  readonly rules: OutputRules;
}

/**
 * Checks one held-back paragraph of the answer before it is released: the
 * persona rules first, then the classifier in the assistant role (ADR-0005).
 */
export function createOutputGuard(config: OutputGuardConfig): OutputGuard {
  return {
    async checkParagraph(text: string, signal: AbortSignal): Promise<OutputVerdict> {
      if (config.rules.check(text) !== undefined) return { ok: false, refusal: 'policy' };
      const outcome = await classifyOrRefuse(config, { role: 'assistant', text }, signal);
      return outcome.ok ? { ok: true, text: mintModerated(text) } : outcome;
    },
  };
}
