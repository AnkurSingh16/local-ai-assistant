import type { ChatChunk, ChatRequest } from '@local-ai/core';
import { isAbortError } from '@local-ai/core';
import { describe, expect, it } from 'vitest';

import {
  createMockChatProvider,
  createMockEmbeddingProvider,
  createMockModerationProvider,
  createMockSearchProvider,
  defaultMockAnswer,
  mockEmbeddingDimensions,
  mockFlagMarkers,
  mockReply,
  textChunks,
} from './index.js';

const request: ChatRequest = {
  messages: [{ role: 'user', content: 'Hello there' }],
  options: { numCtx: 8192, maxOutputTokens: 1200 },
};

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

function textOf(chunks: readonly ChatChunk[]): string {
  return chunks.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

describe('mock chat provider', () => {
  it('streams the default answer and ends with one done chunk', async () => {
    const provider = createMockChatProvider();
    const chunks = await collect(provider.chat(request, new AbortController().signal));
    expect(textOf(chunks)).toBe(defaultMockAnswer);
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', finishReason: 'stop' });
  });

  it('records each request', async () => {
    const provider = createMockChatProvider();
    await collect(provider.chat(request, new AbortController().signal));
    expect(provider.calls).toEqual([request]);
  });

  it('uses a scripted reply', async () => {
    const provider = createMockChatProvider({ reply: (req) => mockReply('Scripted.', req) });
    const chunks = await collect(provider.chat(request, new AbortController().signal));
    expect(textOf(chunks)).toBe('Scripted.');
  });

  it('stops with the abort reason when the signal aborts mid-stream', async () => {
    const provider = createMockChatProvider({ delayMs: 5 });
    const controller = new AbortController();
    const seen: ChatChunk[] = [];
    const run = (async () => {
      for await (const chunk of provider.chat(request, controller.signal)) {
        seen.push(chunk);
        if (seen.length === 2) controller.abort();
      }
    })();
    const err: unknown = await run.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const provider = createMockChatProvider();
    const controller = new AbortController();
    controller.abort();
    const err: unknown = await collect(provider.chat(request, controller.signal)).catch(
      (e: unknown) => e,
    );
    expect(isAbortError(err)).toBe(true);
  });

  it('keeps whitespace when splitting text into chunks', () => {
    const chunks = textChunks('One two\n\nthree');
    expect(textOf(chunks)).toBe('One two\n\nthree');
    expect(chunks).toHaveLength(3);
    expect(textChunks('')).toEqual([]);
  });
});

describe('mock search provider', () => {
  it('returns limit results by default and records queries', async () => {
    const provider = createMockSearchProvider();
    const results = await provider.search({ query: 'q', limit: 3 }, new AbortController().signal);
    expect(results.map((r) => r.url)).toEqual([
      'https://example.com/result-1',
      'https://example.com/result-2',
      'https://example.com/result-3',
    ]);
    expect(provider.calls).toEqual([{ query: 'q', limit: 3 }]);
  });

  it('caps scripted results at the limit', async () => {
    const provider = createMockSearchProvider({
      results: () => [
        { url: 'https://a.test/', title: 'A', snippet: 'a' },
        { url: 'https://b.test/', title: 'B', snippet: 'b' },
      ],
    });
    const results = await provider.search({ query: 'q', limit: 1 }, new AbortController().signal);
    expect(results).toHaveLength(1);
  });

  it('honours abort while waiting', async () => {
    const provider = createMockSearchProvider({ delayMs: 1000 });
    const controller = new AbortController();
    const pending = provider.search({ query: 'q', limit: 1 }, controller.signal);
    controller.abort();
    const err: unknown = await pending.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
  });
});

describe('mock embedding provider', () => {
  const signal = new AbortController().signal;

  it('is deterministic and unit length', async () => {
    const provider = createMockEmbeddingProvider();
    const [a1, b] = await provider.embed(['alpha', 'beta'], signal);
    const [a2] = await provider.embed(['alpha'], signal);
    expect(provider.dimensions).toBe(mockEmbeddingDimensions);
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
    const norm = Math.sqrt((a1 ?? new Float32Array()).reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('honours a custom dimension and an aborted signal', async () => {
    const provider = createMockEmbeddingProvider(8);
    const [v] = await provider.embed(['x'], signal);
    expect(v).toHaveLength(8);
    const controller = new AbortController();
    controller.abort();
    await expect(provider.embed(['x'], controller.signal)).rejects.toThrow();
  });
});

describe('mock moderation provider', () => {
  const signal = new AbortController().signal;

  it('passes ordinary text and flags the markers', async () => {
    const provider = createMockModerationProvider();
    expect(await provider.classify({ role: 'user', text: 'hello' }, signal)).toEqual({
      flagged: false,
    });
    expect(
      await provider.classify({ role: 'user', text: `x ${mockFlagMarkers.violent}` }, signal),
    ).toEqual({ flagged: true, categories: ['S1'] });
    expect(
      await provider.classify({ role: 'user', text: mockFlagMarkers.selfHarm }, signal),
    ).toEqual({ flagged: true, categories: ['S11'] });
    expect(provider.calls).toHaveLength(3);
  });

  it('uses a scripted classifier, which may throw to simulate an outage', async () => {
    const provider = createMockModerationProvider({
      classify: () => {
        throw new Error('guard unavailable');
      },
    });
    await expect(provider.classify({ role: 'assistant', text: 'x' }, signal)).rejects.toThrow(
      'guard unavailable',
    );
  });
});
