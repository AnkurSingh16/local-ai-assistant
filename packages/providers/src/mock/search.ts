import type { SearchProvider, SearchQuery, SearchResult } from '@local-ai/core';

import { sleep } from './sleep.js';

export interface MockSearchOptions {
  readonly results?: (q: SearchQuery) => readonly SearchResult[];
  readonly delayMs?: number;
}

export interface MockSearchProvider extends SearchProvider {
  readonly calls: readonly SearchQuery[];
}

function defaultResults(q: SearchQuery): SearchResult[] {
  return Array.from({ length: q.limit }, (_, i) => ({
    url: `https://example.com/result-${String(i + 1)}`,
    title: `Mock result ${String(i + 1)}`,
    snippet: `A fixed snippet for mock result ${String(i + 1)}.`,
  }));
}

export function createMockSearchProvider(options: MockSearchOptions = {}): MockSearchProvider {
  const calls: SearchQuery[] = [];
  const results = options.results ?? defaultResults;
  return {
    calls,
    async search(q: SearchQuery, signal: AbortSignal): Promise<SearchResult[]> {
      calls.push(q);
      await sleep(options.delayMs ?? 0, signal);
      return results(q).slice(0, q.limit);
    },
  };
}
