import type { SearchProvider, SearchResult, ToolDefinition } from '@local-ai/core';
import { isAbortError } from '@local-ai/core';
import { z } from 'zod';

import type { TtlCache } from './cache.js';

/** One search per turn returns at most this many results (ADR-0003). */
export const maxSearchResults = 5;
export const maxQueryChars = 200;

export const webSearchDefinition: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web for current information. Use it for recent events, prices, scores, releases, people in current roles, and anything that may have changed since your training.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'A short search query, not the whole user message.',
        maxLength: maxQueryChars,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

const argsSchema = z.strictObject({ query: z.string().trim().min(1).max(maxQueryChars) });

export type WebSearchOutcome =
  | { readonly ok: true; readonly query: string; readonly results: readonly SearchResult[] }
  | { readonly ok: false; readonly error: 'invalid_arguments' | 'unavailable' };

export interface WebSearch {
  run(args: unknown, signal: AbortSignal): Promise<WebSearchOutcome>;
}

export interface WebSearchConfig {
  readonly search: SearchProvider;
  readonly cache: TtlCache<readonly SearchResult[]>;
  /** ADR-0003: a search gets 5 s. */
  readonly timeoutMs: number;
}

/** Spacing and case do not change the results, so they do not split the cache. */
const normalise = (query: string): string => query.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The web_search tool. Arguments are validated with Zod; invalid arguments and
 * provider failures become an error result for the model, never a retry loop
 * (ADR-0003). Only the caller's own abort is rethrown.
 */
export function createWebSearch(config: WebSearchConfig): WebSearch {
  return {
    async run(args: unknown, signal: AbortSignal): Promise<WebSearchOutcome> {
      const parsed = argsSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: 'invalid_arguments' };
      const query = parsed.data.query;
      const key = normalise(query);
      const cached = config.cache.get(key);
      if (cached !== undefined) return { ok: true, query, results: cached };
      try {
        const results = await config.search.search(
          { query, limit: maxSearchResults },
          AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
        );
        const kept = results.slice(0, maxSearchResults);
        config.cache.set(key, kept);
        return { ok: true, query, results: kept };
      } catch (err) {
        if (signal.aborted && isAbortError(err)) throw err;
        return { ok: false, error: 'unavailable' };
      }
    },
  };
}
