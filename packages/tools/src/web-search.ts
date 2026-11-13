import type { SearchProvider, SearchResult, ToolDefinition } from '@local-ai/core';
import { isAbortError } from '@local-ai/core';
import { createRules } from '@local-ai/guardrails';
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
  | { readonly ok: false; readonly error: 'invalid_arguments' | 'blocked_query' | 'unavailable' };

export interface WebSearch {
  run(args: unknown, signal: AbortSignal): Promise<WebSearchOutcome>;
}

export interface WebSearchConfig {
  readonly search: SearchProvider;
  readonly cache: TtlCache<readonly SearchResult[]>;
  /** ADR-0003: a search gets 5 s. */
  readonly timeoutMs: number;
}

/**
 * ADR-0003: a query that matches the personal-data patterns of ADR-0009 never
 * goes to a search engine. Checked here, inside the tool, so forced and
 * model-chosen queries both pass through it. The approved-memory overlap check
 * runs in the agent (steps.ts), which knows the memory in the turn's prompt.
 */
const personalDataRules = createRules({ categories: ['personal_data'] });

/** The ADR-0009 patterns the input rules do not cover: they guard chat, not queries. */
const queryPatterns: readonly RegExp[] = [
  // An email address, with a letters-only top-level domain so "lodash@4.17.21" passes.
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/i,
  // Six or more digits in a row, also inside an ID such as GB123456789. Hex
  // error codes and Windows KB numbers are excluded, since people search for them.
  /(?<!\d)(?<!0x[0-9a-f]{0,16})(?<!\bkb ?)\d{6,}/i,
  // A URL with a query string, which often carries tokens or identifiers.
  /\bhttps?:\/\/\S*\?\S*=/i,
];

/** A phone number written in groups: 555-123-4567, (212) 555-2024, +44 20 7946 0958, 555-1234. */
const phoneShaped =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-])?\d{3,4}[\s.-]\d{4}\b|(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g;

/** "2024 2025 2026" is a run of years, not a phone number: every group must be a year to pass. */
function hasPhoneNumber(query: string): boolean {
  for (const match of query.matchAll(phoneShaped)) {
    const groups = match[0].match(/\d+/g) ?? [];
    if (!groups.every((g) => /^(?:19|20)\d\d$/.test(g))) return true;
  }
  return false;
}

/** True when a search query looks like it carries personal data. */
export function queryHasPersonalData(query: string): boolean {
  return (
    personalDataRules.check(query) !== undefined ||
    hasPhoneNumber(query) ||
    queryPatterns.some((p) => p.test(query))
  );
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
      if (queryHasPersonalData(query)) return { ok: false, error: 'blocked_query' };
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
