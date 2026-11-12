import type {
  HazardCategory,
  ModerationInput,
  ModerationProvider,
  ModerationVerdict,
} from '@local-ai/core';
import { hazardCategories, ProviderError } from '@local-ai/core';
import { z } from 'zod';

import type { FetchFn } from './http.js';
import { postJson } from './http.js';

export interface OllamaModerationConfig {
  readonly baseUrl: string;
  /** llama-guard3:1b below 24 GB of RAM, llama-guard3:8b above (ADR-0006). */
  readonly model: string;
  readonly keepAlive: string;
  readonly fetch: FetchFn;
}

/** Guard calls use a fixed, small context (ADR-0005). */
export const guardNumCtx = 2048;

/**
 * llama-guard3 classifies the last turn of a conversation. For an assistant
 * paragraph it needs a preceding user turn; the real user message is not sent,
 * so the verdict depends on the paragraph alone.
 */
const withheldUserTurn = '(user message withheld)';

const responseSchema = z.object({ message: z.object({ content: z.string() }) });

const categorySet: ReadonlySet<string> = new Set(hazardCategories);

function isHazardCategory(value: string): value is HazardCategory {
  return categorySet.has(value);
}

/**
 * Parses "safe" or "unsafe\nS1,S10". Anything else throws, so a confused guard
 * fails closed instead of passing text it did not classify.
 */
export function parseGuardVerdict(content: string): ModerationVerdict {
  const lines = content
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 1 && lines[0] === 'safe') return { flagged: false };
  if (lines[0] === 'unsafe' && lines.length === 2 && lines[1] !== undefined) {
    const codes = lines[1].split(',').map((c) => c.trim());
    const categories = codes.filter(isHazardCategory);
    if (categories.length > 0 && categories.length === codes.length) {
      return { flagged: true, categories };
    }
  }
  throw new ProviderError('bad_response');
}

export function createOllamaModerationProvider(config: OllamaModerationConfig): ModerationProvider {
  const url = new URL('/api/chat', config.baseUrl).toString();
  return {
    async classify(input: ModerationInput, signal: AbortSignal): Promise<ModerationVerdict> {
      const messages =
        input.role === 'user'
          ? [{ role: 'user', content: input.text }]
          : [
              { role: 'user', content: withheldUserTurn },
              { role: 'assistant', content: input.text },
            ];
      const res = await postJson(
        config.fetch,
        url,
        {
          model: config.model,
          messages,
          stream: false,
          keep_alive: config.keepAlive,
          options: { num_ctx: guardNumCtx, temperature: 0, num_predict: 20 },
        },
        signal,
      );
      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        signal.throwIfAborted();
        throw new ProviderError('bad_response', res.status, { cause: err });
      }
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) throw new ProviderError('bad_response', res.status);
      return parseGuardVerdict(parsed.data.message.content);
    },
  };
}
