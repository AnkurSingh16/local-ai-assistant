import type { ChatProvider, ModerationProvider, ModerationVerdict } from '@local-ai/core';
import { mockReply } from '@local-ai/providers/mock';

import type { RecordedCase } from './schema.js';

/**
 * Thrown when a replayed turn needs something the fixtures do not hold, which
 * means the pipeline changed since recording. Re-record rather than guess.
 */
export class StaleFixtureError extends Error {
  constructor(caseId: string, what: string) {
    super(`Fixture for ${caseId} has no recorded ${what}; run npm run eval:record.`);
    this.name = 'StaleFixtureError';
  }
}

/** Providers that replay one case's recorded chat answer and guard verdicts (ADR-0012). */
export function replayProviders(
  caseId: string,
  recorded: RecordedCase | undefined,
): { chat: ChatProvider; moderation: ModerationProvider; stale: () => boolean } {
  // A guard error is turned into an `unavailable` refusal by design, which would
  // make a stale fixture look like a pass; this flag lets the runner fail it.
  let stale = false;
  const missing = (what: string): Promise<never> => {
    stale = true;
    return Promise.reject(new StaleFixtureError(caseId, what));
  };
  const verdicts = new Map<string, ModerationVerdict>(
    (recorded?.units ?? []).map((u) => [u.text, u.verdict]),
  );
  return {
    stale: () => stale,
    chat: {
      async *chat(req) {
        await Promise.resolve();
        if (recorded?.answer === undefined) {
          stale = true;
          throw new StaleFixtureError(caseId, 'answer');
        }
        yield* mockReply(recorded.answer, req);
      },
    },
    moderation: {
      classify(input) {
        if (input.role === 'user') {
          if (recorded?.input === undefined) return missing('input verdict');
          return Promise.resolve(recorded.input);
        }
        const verdict = verdicts.get(input.text);
        if (verdict === undefined) return missing('paragraph verdict');
        return Promise.resolve(verdict);
      },
      isResident: () => Promise.resolve(true),
    },
  };
}
