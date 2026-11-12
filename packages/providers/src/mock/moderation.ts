import type { ModerationInput, ModerationProvider, ModerationVerdict } from '@local-ai/core';

import { sleep } from './sleep.js';

/** Markers that make the default mock moderator flag text, so tests read as intent rather than as harmful content. */
export const mockFlagMarkers = {
  selfHarm: 'MOCK_FLAG_SELF_HARM',
  violent: 'MOCK_FLAG',
} as const;

export interface MockModerationOptions {
  readonly classify?: (input: ModerationInput) => ModerationVerdict;
  readonly delayMs?: number;
}

export interface MockModerationProvider extends ModerationProvider {
  readonly calls: readonly ModerationInput[];
}

function defaultClassify(input: ModerationInput): ModerationVerdict {
  if (input.text.includes(mockFlagMarkers.selfHarm)) return { flagged: true, categories: ['S11'] };
  if (input.text.includes(mockFlagMarkers.violent)) return { flagged: true, categories: ['S1'] };
  return { flagged: false };
}

export function createMockModerationProvider(
  options: MockModerationOptions = {},
): MockModerationProvider {
  const calls: ModerationInput[] = [];
  const classify = options.classify ?? defaultClassify;
  return {
    calls,
    async classify(input: ModerationInput, signal: AbortSignal): Promise<ModerationVerdict> {
      calls.push(input);
      await sleep(options.delayMs ?? 0, signal);
      return classify(input);
    },
  };
}
