import { createManualClock, isAbortError } from '@local-ai/core';
import { createMockSearchProvider } from '@local-ai/providers/mock';
import { describe, expect, it } from 'vitest';

import { createTtlCache } from './cache.js';
import type { WebSearchOutcome } from './web-search.js';
import { createWebSearch, maxSearchResults } from './web-search.js';

const start = new Date('2026-11-13T00:00:00Z');
const key = new Uint8Array(32).fill(7);
const signal = new AbortController().signal;

describe('TTL cache', () => {
  it('expires entries after the TTL', () => {
    const clock = createManualClock(start);
    const cache = createTtlCache<string>({ clock, ttlMs: 1000, maxEntries: 10, hmacKey: key });
    cache.set('q', 'v');
    clock.advance(999);
    expect(cache.get('q')).toBe('v');
    clock.advance(1);
    expect(cache.get('q')).toBeUndefined();
  });

  it('evicts the least recently used entry beyond the limit', () => {
    const cache = createTtlCache<number>({
      clock: createManualClock(start),
      ttlMs: 1000,
      maxEntries: 2,
      hmacKey: key,
    });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.size).toBe(2);
  });

  it('keys by HMAC, so caches with different keys do not share entries', () => {
    const clock = createManualClock(start);
    const one = createTtlCache<number>({ clock, ttlMs: 1000, maxEntries: 5, hmacKey: key });
    one.set('secret query', 1);
    const other = createTtlCache<number>({
      clock,
      ttlMs: 1000,
      maxEntries: 5,
      hmacKey: new Uint8Array(32).fill(9),
    });
    expect(other.get('secret query')).toBeUndefined();
  });
});

describe('web_search tool', () => {
  const cacheFor = () =>
    createTtlCache<never>({
      clock: createManualClock(start),
      ttlMs: 600_000,
      maxEntries: 100,
      hmacKey: key,
    });

  it('returns at most five results', async () => {
    const search = createMockSearchProvider();
    const tool = createWebSearch({ search, cache: cacheFor(), timeoutMs: 1000 });
    const outcome = await tool.run({ query: 'latest node release' }, signal);
    expect(outcome.ok && outcome.results.length).toBe(maxSearchResults);
    expect(search.calls[0]).toEqual({ query: 'latest node release', limit: 5 });
  });

  it('rejects invalid arguments without searching', async () => {
    const search = createMockSearchProvider();
    const tool = createWebSearch({ search, cache: cacheFor(), timeoutMs: 1000 });
    for (const args of [{}, { query: '' }, { query: 'x'.repeat(201) }, { query: 'a', extra: 1 }]) {
      expect(await tool.run(args, signal)).toEqual({ ok: false, error: 'invalid_arguments' });
    }
    expect(search.calls).toHaveLength(0);
  });

  it('serves a repeat query from the cache, ignoring case and spacing', async () => {
    const search = createMockSearchProvider();
    const tool = createWebSearch({ search, cache: cacheFor(), timeoutMs: 1000 });
    await tool.run({ query: 'Node  Release' }, signal);
    const second: WebSearchOutcome = await tool.run({ query: 'node release' }, signal);
    expect(second.ok).toBe(true);
    expect(search.calls).toHaveLength(1);
  });

  it('reports a slow or failing provider as unavailable', async () => {
    const slow = createWebSearch({
      search: createMockSearchProvider({ delayMs: 200 }),
      cache: cacheFor(),
      timeoutMs: 10,
    });
    expect(await slow.run({ query: 'q' }, signal)).toEqual({ ok: false, error: 'unavailable' });
    const failing = createWebSearch({
      search: {
        search: () => Promise.reject(new Error('down')),
      },
      cache: cacheFor(),
      timeoutMs: 1000,
    });
    expect(await failing.run({ query: 'q' }, signal)).toEqual({ ok: false, error: 'unavailable' });
  });

  it('rethrows the caller abort', async () => {
    const tool = createWebSearch({
      search: createMockSearchProvider({ delayMs: 200 }),
      cache: cacheFor(),
      timeoutMs: 1000,
    });
    const controller = new AbortController();
    const pending = tool.run({ query: 'q' }, controller.signal).catch((e: unknown) => e);
    controller.abort();
    expect(isAbortError(await pending)).toBe(true);
  });
});
