# ADR-0011: Search cache and rate limits

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Ankur Pawar

## Context

Search results and extracted pages are worth caching briefly to save time and avoid getting SearXNG's upstream engines to block me. Rate limits protect a single GPU from abuse (OWASP LLM10 Unbounded Consumption). Queries are user-derived and may be personal.

## Options considered

1. **Valkey or Redis** for both cache and limits. One more container for state that can be lost on restart without harm.
2. **A hand-rolled in-memory limiter** with an injected clock.
3. **`@fastify/rate-limit`** with a custom store that reads the injected `Clock`, plus a SQLite cache table.

## Decision

Option 3.

- **Cache:** a `search_cache` table keyed by HMAC-SHA256 of the normalised query and parameters. The HMAC key is generated at random on each start and held only in memory, and the cache is emptied on start, so query text is never stored and keys cannot be brute-forced from the database. TTLs: search results 10 minutes (searches mostly answer time-sensitive questions), page extracts 1 hour; the date and time are never cached. The table holds at most 5,000 rows, evicting the least recently used. Only SearXNG results and `safeFetch` output are written; cached pages are wrapped as untrusted again on every read.
- **Rate limits:** `@fastify/rate-limit` with a store backed by the injected `Clock`, keyed per session and per IP (IPv6 grouped by /64): 20 turns per 10 minutes per session, 60 per 10 minutes per IP, 10 new sessions per hour per IP. A global cap allows 2 concurrent turns with a queue of 4; beyond that the API answers 503 with `Retry-After`. I set `OLLAMA_NUM_PARALLEL=1` explicitly, so two concurrent turns already queue for the GPU and more would only add waiting.
- Limits live in memory behind the store interface. Restarting the API resets them, which is acceptable for one process.

**Amended 2026-11-13.** Until the storage package arrives in Milestone 5, the cache is an in-memory map with the same keys, lifetimes and size (`packages/tools/src/cache.ts`). It holds no query text either and is emptied on restart, as the table would be.

## Consequences

- Limits are deterministic in tests and need no extra container.
- With more than one API process, limits and cache move to a shared store (Redis); the store interface keeps that change local.
- The numbers are starting points. I tune them from measured turn times, and record changes here.

## Evidence

- `@fastify/rate-limit` 11.2.2 accepts a custom `store`; its only `Date.now()` calls are in the bundled `LocalStore`, so a store reading our `Clock` makes it deterministic (inspected 2026-11-12).
- Generation runs at about 26 tokens/s on my Mac, so a typical answer takes 10 to 20 s; 20 turns per 10 minutes is about one turn every 30 s.
- OWASP LLM10:2025 Unbounded Consumption: https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/ (accessed 2026-11-12).

**Amended 2026-11-13 (Milestone 6).** `@fastify/rate-limit` runs one limiter per request, so the per-session limit is a small fixed-window counter on the injected clock in the chat route (`createWindowLimiter` in `apps/api/src/limits.ts`). It has the same limits and the same 429 response with `Retry-After`. It is keyed by session id, never by the token. A turn counts as soon as it passes validation, including one later refused for an unknown conversation or a full queue.
