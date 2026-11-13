import { isAbortError, ProviderError } from '@local-ai/core';
import { describe, expect, it } from 'vitest';

import type { FetchFn } from '../shared/http.js';
import { createSearxngSearchProvider } from './search.js';

describe('SearXNG search provider', () => {
  const searchBase = { baseUrl: 'http://127.0.0.1:8888' };
  const signal = new AbortController().signal;
  const fetchJson =
    (body: unknown, urls: string[] = [], status = 200): FetchFn =>
    (url) => {
      urls.push(url);
      return Promise.resolve(Response.json(body, { status }));
    };

  it('queries the JSON API with safe search and keeps https results only, deduplicated', async () => {
    const urls: string[] = [];
    const provider = createSearxngSearchProvider({
      ...searchBase,
      fetch: fetchJson(
        {
          results: [
            { url: 'http://insecure.example/a', title: 'A' },
            { url: 'https://one.example/', title: ' One ', content: 'first\n snippet' },
            { url: 'https://one.example/', title: 'Duplicate' },
            { url: 'javascript:alert(1)', title: 'Bad' },
            { url: 'https://two.example/', title: 'Two' },
            { url: 'https://three.example/', title: 'Three' },
          ],
        },
        urls,
      ),
    });
    const results = await provider.search({ query: 'node 24', limit: 2 }, signal);
    expect(results).toEqual([
      { url: 'https://one.example/', title: 'One', snippet: 'first snippet' },
      { url: 'https://two.example/', title: 'Two', snippet: '' },
    ]);
    const sent = new URL(urls[0] ?? '');
    expect(sent.pathname).toBe('/search');
    expect(sent.searchParams.get('q')).toBe('node 24');
    expect(sent.searchParams.get('format')).toBe('json');
    expect(sent.searchParams.get('safesearch')).toBe('2');
  });

  it('cuts long titles and snippets', async () => {
    const provider = createSearxngSearchProvider({
      ...searchBase,
      fetch: fetchJson({
        results: [{ url: 'https://a.example/', title: 't'.repeat(500), content: 's'.repeat(900) }],
      }),
    });
    const [first] = await provider.search({ query: 'q', limit: 5 }, signal);
    expect(first?.title).toHaveLength(200);
    expect(first?.snippet).toHaveLength(500);
  });

  it('throws a ProviderError when SearXNG fails or answers badly', async () => {
    for (const fetchFn of [
      fetchJson({ error: 'x' }, [], 500),
      fetchJson({ nope: true }),
      (() => Promise.resolve(new Response('x'.repeat(1_100_000)))) satisfies FetchFn,
      (() => Promise.reject(new TypeError('fetch failed'))) satisfies FetchFn,
    ]) {
      const provider = createSearxngSearchProvider({ ...searchBase, fetch: fetchFn });
      await expect(provider.search({ query: 'q', limit: 5 }, signal)).rejects.toBeInstanceOf(
        ProviderError,
      );
    }
  });
});

describe('SearXNG search provider edge cases', () => {
  const signal = new AbortController().signal;
  const one =
    (results: unknown[]): FetchFn =>
    () =>
      Promise.resolve(Response.json({ results }));

  it('drops URLs with credentials or over 2,048 characters, and matches duplicates after normalising', async () => {
    const provider = createSearxngSearchProvider({
      baseUrl: 'http://127.0.0.1:8888',
      fetch: one([
        { url: 'https://user:pass@a.example/', title: 'creds' },
        { url: `https://long.example/${'x'.repeat(2100)}`, title: 'long' },
        { url: 'https://b.example', title: 'B' },
        { url: 'https://b.example/', title: 'B again' },
      ]),
    });
    expect(await provider.search({ query: 'q', limit: 5 }, signal)).toEqual([
      { url: 'https://b.example/', title: 'B', snippet: '' },
    ]);
  });

  it('keeps a path prefix in the base URL and refuses redirects', async () => {
    const seen: { url: string; redirect: RequestRedirect | undefined }[] = [];
    const provider = createSearxngSearchProvider({
      baseUrl: 'http://127.0.0.1:8888/searx',
      fetch: (url, init) => {
        seen.push({ url, redirect: init.redirect });
        return Promise.resolve(Response.json({ results: [] }));
      },
    });
    await provider.search({ query: 'q', limit: 5 }, signal);
    expect(new URL(seen[0]?.url ?? '').pathname).toBe('/searx/search');
    expect(seen[0]?.redirect).toBe('error');
  });

  it('rethrows the caller abort and treats an empty body as unavailable', async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = createSearxngSearchProvider({
      baseUrl: 'http://127.0.0.1:8888',
      fetch: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    });
    const err = await aborted
      .search({ query: 'q', limit: 5 }, controller.signal)
      .catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    const empty = createSearxngSearchProvider({
      baseUrl: 'http://127.0.0.1:8888',
      fetch: () => Promise.resolve(new Response(null)),
    });
    await expect(empty.search({ query: 'q', limit: 5 }, signal)).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});
