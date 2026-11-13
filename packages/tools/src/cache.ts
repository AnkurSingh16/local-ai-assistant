import { createHmac } from 'node:crypto';

import type { Clock } from '@local-ai/core';

/**
 * A small TTL cache for search results and page extracts (ADR-0011). Entries
 * are keyed by HMAC-SHA256 of the normalised request under a key that exists
 * only in memory for the life of the process, so the cache never holds query
 * text and a key cannot be reversed by guessing queries. It lives in memory
 * until the storage package arrives in Milestone 5; restarting empties it,
 * which ADR-0011 asks for anyway.
 */
export interface TtlCache<T> {
  get(request: string): T | undefined;
  set(request: string, value: T): void;
  readonly size: number;
}

export interface TtlCacheConfig {
  readonly clock: Clock;
  readonly ttlMs: number;
  readonly maxEntries: number;
  /** Random bytes generated at start-up by the composition root. */
  readonly hmacKey: Uint8Array;
}

export function createTtlCache<T>(config: TtlCacheConfig): TtlCache<T> {
  // A Map keeps insertion order, so re-inserting on read makes the first key the least recently used.
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const keyOf = (request: string): string =>
    createHmac('sha256', config.hmacKey).update(request).digest('hex');

  return {
    get(request: string): T | undefined {
      const key = keyOf(request);
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      entries.delete(key);
      if (entry.expiresAt <= config.clock.monotonicMs()) return undefined;
      entries.set(key, entry);
      return entry.value;
    },
    set(request: string, value: T): void {
      const key = keyOf(request);
      entries.delete(key);
      entries.set(key, { value, expiresAt: config.clock.monotonicMs() + config.ttlMs });
      while (entries.size > config.maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    get size(): number {
      return entries.size;
    },
  };
}
