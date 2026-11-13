import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Assistant, WebTools } from '@local-ai/agent';
import { createAssistant, leakCheckPrompt, personaCanary } from '@local-ai/agent';
import type { ChatProvider, Clock, ModerationProvider } from '@local-ai/core';
import {
  createCircuitBreaker,
  createInputGuard,
  createOutputGuard,
  createOutputRules,
} from '@local-ai/guardrails';
import {
  createOllamaChatProvider,
  createOllamaEmbeddingProvider,
  createOllamaModerationProvider,
  createSearxngSearchProvider,
} from '@local-ai/providers';
import {
  createMockChatProvider,
  createMockEmbeddingProvider,
  createMockModerationProvider,
  createMockSearchProvider,
} from '@local-ai/providers/mock';
import {
  createConversationRepo,
  createFlagLog,
  createMemoryRepo,
  createReviewRepo,
  createSessionRepo,
  openDatabase,
} from '@local-ai/storage';
import type { HopFetch } from '@local-ai/tools';
import {
  createPageParser,
  createReadPage,
  createSafeFetch,
  createTtlCache,
  createUndiciHop,
  createWebSearch,
  maxCacheEntries,
  pageCacheTtlMs,
  searchCacheTtlMs,
  systemResolve,
} from '@local-ai/tools';

import type { FetchFn } from '@local-ai/providers';

import type { Config } from './config.js';
import type { FeedbackService } from './learning.js';
import { createFeedbackService, createMemoryRecall } from './learning.js';
import type { SessionService } from './sessions.js';
import { createSessionService } from './sessions.js';

/**
 * The composition root (ADR-0002): the only module in the API that imports
 * providers. Routes receive the assistant and nothing else.
 */
export interface Composition {
  readonly assistant: Assistant;
  readonly moderation: ModerationProvider;
  /** True once any guard classification has succeeded (ADR-0005). */
  readonly isReady: () => boolean;
  readonly sessions: SessionService;
  readonly feedback: FeedbackService;
  /** Closes the database on shutdown. */
  readonly close: () => void;
}

/** Marks the API ready on the first successful classification, whether warm-up or a real turn. */
export function trackReadiness(moderation: ModerationProvider): {
  moderation: ModerationProvider;
  isReady: () => boolean;
} {
  let ready = false;
  const isResident = moderation.isResident?.bind(moderation);
  return {
    isReady: () => ready,
    moderation: {
      async classify(input, signal) {
        const verdict = await moderation.classify(input, signal);
        ready = true;
        return verdict;
      },
      ...(isResident === undefined ? {} : { isResident }),
    },
  };
}

/** A fixed page for mock mode, so the read path runs without the network. */
const mockHop: HopFetch = () => {
  const body = new Response(
    '<html><head><title>Mock page</title></head><body><article><p>A fixed page from the mock web, used in tests.</p></article></body></html>',
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  ).body;
  return Promise.resolve({
    status: 200,
    ok: true,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    body:
      body === null
        ? null
        : { getReader: () => body.getReader(), cancel: (reason?: unknown) => body.cancel(reason) },
  });
};

/**
 * Web search and page reading (ADR-0003, ADR-0008). The cache key and the
 * delimiter nonces come from fresh randomness held only in memory.
 */
function webTools(config: Config, clock: Clock, fetchFn: FetchFn): WebTools {
  const hmacKey = randomBytes(32);
  const mock = config.providers === 'mock';
  const search = mock
    ? createMockSearchProvider()
    : createSearxngSearchProvider({ baseUrl: config.searxngUrl, fetch: fetchFn });
  const safeFetch = mock
    ? createSafeFetch({
        resolve: () => Promise.resolve([{ address: '93.184.215.14', family: 4 }]),
        hop: mockHop,
      })
    : createSafeFetch({ resolve: systemResolve, hop: createUndiciHop() });
  return {
    search: createWebSearch({
      search,
      cache: createTtlCache({
        clock,
        ttlMs: searchCacheTtlMs,
        maxEntries: maxCacheEntries,
        hmacKey,
      }),
      timeoutMs: config.searchTimeoutMs,
    }),
    readPage: createReadPage({
      fetch: safeFetch,
      parse: createPageParser(),
      cache: createTtlCache({ clock, ttlMs: pageCacheTtlMs, maxEntries: maxCacheEntries, hmacKey }),
    }),
    nonce: () => randomBytes(12).toString('hex'),
  };
}

export function compose(config: Config, newId: () => string, clock: Clock): Composition {
  const fetchFn: FetchFn = (input, init) => fetch(input, init);
  let chat: ChatProvider;
  let moderation: ModerationProvider;
  if (config.providers === 'mock') {
    chat = createMockChatProvider({ delayMs: 20 });
    moderation = createMockModerationProvider();
  } else {
    chat = createOllamaChatProvider({
      baseUrl: config.ollamaBaseUrl,
      model: config.chatModel,
      keepAlive: config.ollamaKeepAlive,
      fetch: fetchFn,
    });
    moderation = createOllamaModerationProvider({
      baseUrl: config.ollamaBaseUrl,
      model: config.guardModel,
      keepAlive: config.ollamaKeepAlive,
      fetch: fetchFn,
    });
  }
  const tracked = trackReadiness(moderation);
  // One breaker for both guards: they share one model, so they fail together (ADR-0005).
  const guard = {
    moderation: tracked.moderation,
    timeoutMs: config.guardTimeoutMs,
    warmTimeoutMs: config.guardWarmTimeoutMs,
    // The lease outlasts the longest check (residency read plus the cold timeout).
    breaker: createCircuitBreaker({ clock, probeLeaseMs: config.guardTimeoutMs + 1_000 }),
  };
  if (config.databasePath !== ':memory:')
    mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = openDatabase(config.databasePath);
  const storageDeps = { db, clock, newId };
  const sessionRepo = createSessionRepo(storageDeps);
  const conversationRepo = createConversationRepo(storageDeps);
  const memoryRepo = createMemoryRepo(storageDeps);
  const embeddings =
    config.providers === 'mock'
      ? createMockEmbeddingProvider()
      : createOllamaEmbeddingProvider({
          baseUrl: config.ollamaBaseUrl,
          model: config.embedModel,
          keepAlive: config.ollamaKeepAlive,
          fetch: fetchFn,
        });
  // Idle sessions and everything under them go at start-up and every hour
  // after, so a long-running API keeps nothing past the 30-day idle limit (ADR-0009).
  void sessionRepo.purgeIdle();
  setInterval(
    () => {
      void sessionRepo.purgeIdle().catch(() => undefined);
    },
    60 * 60 * 1000,
  ).unref();
  const assistant = createAssistant({
    chat,
    inputGuard: createInputGuard(guard),
    outputGuard: createOutputGuard({
      ...guard,
      rules: createOutputRules({ systemPrompt: leakCheckPrompt, canary: personaCanary }),
    }),
    newId,
    turnTimeoutMs: config.turnTimeoutMs,
    clock,
    web: webTools(config, clock, fetchFn),
    conversations: conversationRepo,
    memory: createMemoryRecall({ memory: memoryRepo, embeddings, timeoutMs: 5_000 }),
  });
  return {
    assistant,
    moderation: tracked.moderation,
    isReady: tracked.isReady,
    sessions: createSessionService({
      sessions: sessionRepo,
      conversations: conversationRepo,
      memory: memoryRepo,
    }),
    feedback: createFeedbackService({
      inputGuard: createInputGuard(guard),
      review: createReviewRepo(storageDeps),
      flags: createFlagLog(storageDeps),
    }),
    close: () => {
      db.close();
    },
  };
}
