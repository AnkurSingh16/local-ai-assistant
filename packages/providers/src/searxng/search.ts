import type { SearchProvider, SearchQuery, SearchResult } from '@local-ai/core';
import { ProviderError } from '@local-ai/core';
import { z } from 'zod';

import type { FetchFn } from '../shared/http.js';
import { parseJsonLine } from '../shared/http.js';
import { readCapped } from '../shared/ndjson.js';

/** A results page is tens of kilobytes; this bounds what a broken instance can make us buffer. */
const maxResponseChars = 1024 * 1024;
/** Snippets and titles are cut, so one result cannot crowd the context budget (ADR-0004). */
const maxTitleChars = 200;
const maxSnippetChars = 500;

export interface SearxngConfig {
  /** The loopback URL compose publishes, http://127.0.0.1:8888 by default (ADR-0010). */
  readonly baseUrl: string;
  readonly fetch: FetchFn;
}

const responseSchema = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
    }),
  ),
});

/** Long enough for real links; anything longer would crowd the context budget (ADR-0004). */
const maxUrlChars = 2048;

/**
 * Keeps https results without credentials, normalised so duplicates match:
 * read_page fetches only such URLs (ADR-0008), so anything else could never be
 * read or cited safely.
 */
function usableUrl(raw: string): string | undefined {
  if (raw.length > maxUrlChars) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

const clean = (text: string | undefined, max: number): string =>
  (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function createSearxngSearchProvider(config: SearxngConfig): SearchProvider {
  return {
    async search(q: SearchQuery, signal: AbortSignal): Promise<SearchResult[]> {
      // Relative to the base, so a path prefix in SEARXNG_URL is kept.
      const url = new URL(
        'search',
        config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`,
      );
      url.searchParams.set('q', q.query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('safesearch', '2');
      url.searchParams.set('categories', 'general');
      let res: Response;
      try {
        res = await config.fetch(url.toString(), {
          method: 'GET',
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal,
        });
      } catch (err) {
        signal.throwIfAborted();
        throw new ProviderError('unavailable', undefined, { cause: err });
      }
      if (!res.ok || res.body === null) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError('unavailable', res.status);
      }
      const parsed = responseSchema.safeParse(
        parseJsonLine(await readCapped(res.body, maxResponseChars, signal)),
      );
      if (!parsed.success) throw new ProviderError('bad_response', res.status);
      const seen = new Set<string>();
      const results: SearchResult[] = [];
      for (const r of parsed.data.results) {
        if (results.length >= q.limit) break;
        const resultUrl = usableUrl(r.url);
        if (resultUrl === undefined || seen.has(resultUrl)) continue;
        seen.add(resultUrl);
        results.push({
          url: resultUrl,
          title: clean(r.title, maxTitleChars),
          snippet: clean(r.content, maxSnippetChars),
        });
      }
      return results;
    },
  };
}
