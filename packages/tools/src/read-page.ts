import type { ToolDefinition } from '@local-ai/core';
import { z } from 'zod';

import type { TtlCache } from './cache.js';
import type { ParsedPage, ParsePage } from './parse.js';
import { ParseFailure } from './parse.js';
import type { SafeFetch, SafeFetchError } from './safe-fetch.js';
import { SafeFetchFailure } from './safe-fetch.js';

export const readPageDefinition: ToolDefinition = {
  name: 'read_page',
  description:
    'Read the main text of one page from the results of this turn’s web_search. Only URLs from those results are allowed.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'A URL exactly as it appeared in the search results.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
};

const argsSchema = z.strictObject({ url: z.string().min(1).max(2048) });

export type ReadPageError =
  'invalid_arguments' | 'not_allowed' | SafeFetchError | 'parse_failed' | 'parse_timeout';

export type ReadPageOutcome =
  | { readonly ok: true; readonly url: string; readonly title: string; readonly text: string }
  | { readonly ok: false; readonly error: ReadPageError };

export interface ReadPage {
  /**
   * Reads one page. `allowedUrls` is this turn's search results: the taint rule
   * (ADR-0003) lets the model read only those, never a URL it or a page made up.
   */
  run(
    args: unknown,
    allowedUrls: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<ReadPageOutcome>;
}

export interface ReadPageConfig {
  readonly fetch: SafeFetch;
  readonly parse: ParsePage;
  /** ADR-0011: page extracts are cached for an hour. */
  readonly cache: TtlCache<ParsedPage & { readonly url: string }>;
}

export function createReadPage(config: ReadPageConfig): ReadPage {
  return {
    async run(args, allowedUrls, signal): Promise<ReadPageOutcome> {
      const parsed = argsSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: 'invalid_arguments' };
      const url = parsed.data.url;
      if (!allowedUrls.has(url)) return { ok: false, error: 'not_allowed' };
      const cached = config.cache.get(url);
      if (cached !== undefined) return { ok: true, ...cached };
      try {
        const page = await config.fetch(url, signal);
        const extract = await config.parse(page, signal);
        const result = { url: page.url, title: extract.title, text: extract.text };
        config.cache.set(url, result);
        return { ok: true, ...result };
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof SafeFetchFailure || err instanceof ParseFailure) {
          return { ok: false, error: err.reason };
        }
        return { ok: false, error: 'unavailable' };
      }
    },
  };
}
