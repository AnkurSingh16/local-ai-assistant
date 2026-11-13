import type { SearchProvider, SearchQuery, SearchResult } from '@local-ai/core';
import { ProviderError } from '@local-ai/core';
import { z } from 'zod';

import type { FetchFn } from '../ollama/http.js';
import { parseJsonLine } from '../ollama/http.js';
import { readCapped } from '../ollama/ndjson.js';

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

/**
 * Keeps https results only: read_page fetches https only (ADR-0008), so an http
 * result could never be read or cited safely.
 */
function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

const clean = (text: string | undefined, max: number): string =>
  (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function createSearxngSearchProvider(config: SearxngConfig): SearchProvider {
  return {
    async search(q: SearchQuery, signal: AbortSignal): Promise<SearchResult[]> {
      const url = new URL('/search', config.baseUrl);
      url.searchParams.set('q', q.query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('safesearch', '1');
      url.searchParams.set('categories', 'general');
      let res: Response;
      try {
        res = await config.fetch(url.toString(), {
          method: 'GET',
          headers: { accept: 'application/json' },
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
        if (!isHttps(r.url) || seen.has(r.url)) continue;
        seen.add(r.url);
        results.push({
          url: r.url,
          title: clean(r.title, maxTitleChars),
          snippet: clean(r.content, maxSnippetChars),
        });
      }
      return results;
    },
  };
}
