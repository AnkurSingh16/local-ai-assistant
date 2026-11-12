import type { ModeratedText } from '@local-ai/core';

/**
 * The only place a ModeratedText is created (ADR-0002). Only the input and
 * output guards import this module; dependency-cruiser enforces that, and the
 * lint rule `local/no-brand-cast` exempts this file alone.
 */
export function mintModerated(text: string): ModeratedText {
  return text as ModeratedText;
}
