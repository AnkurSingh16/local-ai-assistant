import type { ChatChunk, ChatRequest } from '@local-ai/core';
import { isAbortError, ProviderError } from '@local-ai/core';
import { describe, expect, it } from 'vitest';

import type { FetchFn } from '../shared/http.js';
import { createOllamaChatProvider } from './chat.js';
import { createOllamaEmbeddingProvider } from './embeddings.js';
import { createOllamaModerationProvider, parseGuardVerdict } from './moderation.js';
import { readCapped, readLines } from '../shared/ndjson.js';

const encoder = new TextEncoder();

function streamOf(parts: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
}

interface Captured {
  url: string;
  body: unknown;
}

function fakeFetch(
  respond: () => Response | Promise<Response>,
  captured: Captured[] = [],
): FetchFn {
  return async (url, init) => {
    const raw = typeof init.body === 'string' ? init.body : '';
    captured.push({ url, body: JSON.parse(raw) as unknown });
    return respond();
  };
}

const ndjson = (...objs: unknown[]): string => objs.map((o) => JSON.stringify(o) + '\n').join('');

const request: ChatRequest = {
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ name: 'get_current_datetime', arguments: {} }],
    },
    { role: 'tool', content: '2026-11-12', toolName: 'get_current_datetime' },
  ],
  tools: [{ name: 'get_current_datetime', description: 'now', parameters: { type: 'object' } }],
  options: { numCtx: 8192, maxOutputTokens: 1200, temperature: 0.3 },
};

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const base = { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', keepAlive: '30m' };

describe('readLines', () => {
  it('splits lines across chunk boundaries, including multi-byte characters', async () => {
    const bytes = encoder.encode('{"a":"é"}\n\n{"b":2}');
    const parts = [bytes.slice(0, 7), bytes.slice(7, 12), bytes.slice(12)];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(p);
        c.close();
      },
    });
    const lines: string[] = [];
    for await (const l of readLines(body, new AbortController().signal)) lines.push(l);
    expect(lines).toEqual(['{"a":"é"}', '{"b":2}']);
  });

  it('rejects a line longer than the limit', async () => {
    const body = streamOf(['x'.repeat(1_000_001)]);
    const run = async (): Promise<void> => {
      const lines: string[] = [];
      for await (const line of readLines(body, new AbortController().signal)) lines.push(line);
    };
    await expect(run()).rejects.toBeInstanceOf(ProviderError);
  });

  it('cancels the source when the consumer stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('{"a":1}\n{"a":2}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const line of readLines(body, new AbortController().signal)) {
      expect(line).toBe('{"a":1}');
      break;
    }
    expect(cancelled).toBe(true);
  });

  it('does not cancel a source that ended normally', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('{"a":1}'));
        c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const lines: string[] = [];
    for await (const line of readLines(body, new AbortController().signal)) lines.push(line);
    expect(lines).toEqual(['{"a":1}']);
    expect(cancelled).toBe(false);
  });

  it('stops when the signal aborts while waiting for data', async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start: () => undefined });
    const run = (async () => {
      const lines: string[] = [];
      for await (const line of readLines(body, controller.signal)) lines.push(line);
    })();
    controller.abort();
    const err: unknown = await run.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
  });
});

describe('readCapped', () => {
  it('stops when the signal aborts while a read is pending', async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start: () => undefined });
    const pending = readCapped(body, 100, controller.signal).catch((e: unknown) => e);
    controller.abort();
    expect(isAbortError(await pending)).toBe(true);
  });
});

describe('Ollama chat provider', () => {
  it('sends an explicit num_ctx and maps messages, tools and options', async () => {
    const captured: Captured[] = [];
    const provider = createOllamaChatProvider({
      ...base,
      fetch: fakeFetch(
        () => new Response(streamOf([ndjson({ done: true, done_reason: 'stop' })])),
        captured,
      ),
    });
    await collect(provider.chat(request, new AbortController().signal));
    expect(captured[0]?.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(captured[0]?.body).toMatchObject({
      model: 'qwen2.5:7b',
      stream: true,
      keep_alive: '30m',
      options: { num_ctx: 8192, num_predict: 1200, temperature: 0.3 },
      tools: [{ type: 'function', function: { name: 'get_current_datetime' } }],
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          tool_calls: [{ function: { name: 'get_current_datetime', arguments: {} } }],
        },
        { role: 'tool', tool_name: 'get_current_datetime' },
      ],
    });
  });

  it('streams text and reports usage', async () => {
    const provider = createOllamaChatProvider({
      ...base,
      fetch: fakeFetch(
        () =>
          new Response(
            streamOf([
              ndjson({ message: { role: 'assistant', content: 'Hello' }, done: false }),
              ndjson(
                { message: { role: 'assistant', content: ' there' }, done: false },
                {
                  message: { role: 'assistant', content: '' },
                  done: true,
                  done_reason: 'stop',
                  prompt_eval_count: 35,
                  eval_count: 4,
                },
              ),
            ]),
          ),
      ),
    });
    const chunks = await collect(
      provider.chat(
        { messages: request.messages, options: request.options },
        new AbortController().signal,
      ),
    );
    expect(chunks).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' there' },
      { type: 'done', finishReason: 'stop', usage: { promptTokens: 35, outputTokens: 4 } },
    ]);
  });

  it('reports tool calls and marks the finish as tool_calls', async () => {
    const provider = createOllamaChatProvider({
      ...base,
      fetch: fakeFetch(
        () =>
          new Response(
            streamOf([
              ndjson(
                {
                  message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                      { id: 'c1', function: { index: 0, name: 'web_search', arguments: { q: 1 } } },
                    ],
                  },
                  done: false,
                },
                { message: { content: '' }, done: true, done_reason: 'stop' },
              ),
            ]),
          ),
      ),
    });
    const chunks = await collect(provider.chat(request, new AbortController().signal));
    expect(chunks).toEqual([
      { type: 'tool_call', call: { name: 'web_search', arguments: { q: 1 } } },
      { type: 'done', finishReason: 'tool_calls', usage: { promptTokens: 0, outputTokens: 0 } },
    ]);
  });

  it('maps done_reason length', async () => {
    const provider = createOllamaChatProvider({
      ...base,
      fetch: fakeFetch(
        () => new Response(streamOf([ndjson({ done: true, done_reason: 'length' })])),
      ),
    });
    const chunks = await collect(provider.chat(request, new AbortController().signal));
    expect(chunks.at(-1)).toMatchObject({ finishReason: 'length' });
  });

  it.each([
    [
      'a 404 as model_missing',
      () => new Response('{"error":"model not found"}', { status: 404 }),
      'model_missing',
    ],
    ['a 500 as unavailable', () => new Response('boom', { status: 500 }), 'unavailable'],
    [
      'an error line as unavailable',
      () => new Response(streamOf([ndjson({ error: 'oom' })])),
      'unavailable',
    ],
    [
      'a malformed line as bad_response',
      () => new Response(streamOf(['not json\n'])),
      'bad_response',
    ],
    [
      'an unexpected shape as bad_response',
      () => new Response(streamOf([ndjson({ done: 'yes' })])),
      'bad_response',
    ],
    [
      'a stream without done as unavailable',
      () => new Response(streamOf([ndjson({ message: { content: 'x' }, done: false })])),
      'unavailable',
    ],
    ['an empty body as bad_response', () => new Response(null), 'bad_response'],
  ])('maps %s', async (_name, respond, kind) => {
    const provider = createOllamaChatProvider({ ...base, fetch: fakeFetch(respond) });
    const err: unknown = await collect(provider.chat(request, new AbortController().signal)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe(kind);
    expect((err as ProviderError).message).not.toMatch(/oom|boom|not found/);
  });

  it('keeps parse errors free of the response text', async () => {
    const provider = createOllamaChatProvider({
      ...base,
      fetch: fakeFetch(() => new Response(streamOf(['secret user text\n']))),
    });
    const err: unknown = await collect(provider.chat(request, new AbortController().signal)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).cause).toBeUndefined();
  });

  it('maps a network failure to unavailable', async () => {
    const provider = createOllamaChatProvider({
      ...base,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const err: unknown = await collect(provider.chat(request, new AbortController().signal)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ kind: 'unavailable' });
  });

  it('rethrows the abort, not a provider error, when the caller cancels', async () => {
    const controller = new AbortController();
    const provider = createOllamaChatProvider({
      ...base,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new TypeError('aborted underneath'));
          });
        }),
    });
    const pending = collect(provider.chat(request, controller.signal)).catch((e: unknown) => e);
    controller.abort();
    expect(isAbortError(await pending)).toBe(true);
  });
});

describe('llama-guard verdict parsing', () => {
  it.each([
    ['safe', { flagged: false }],
    ['  safe\n', { flagged: false }],
    ['unsafe\nS1', { flagged: true, categories: ['S1'] }],
    ['unsafe\nS1, S10', { flagged: true, categories: ['S1', 'S10'] }],
  ])('parses %j', (content, verdict) => {
    expect(parseGuardVerdict(content)).toEqual(verdict);
  });

  it.each([
    '',
    'Safe',
    'unsafe',
    'unsafe\nS99',
    'unsafe\nS1,banana',
    'safe\nextra',
    'I cannot help',
  ])('fails closed on %j', (content) => {
    expect(() => parseGuardVerdict(content)).toThrow(ProviderError);
  });
});

describe('Ollama moderation provider', () => {
  const guardBase = { ...base, model: 'llama-guard3:1b' };

  it('classifies a user message with a small fixed context', async () => {
    const captured: Captured[] = [];
    const provider = createOllamaModerationProvider({
      ...guardBase,
      fetch: fakeFetch(() => Response.json({ message: { content: 'unsafe\nS1' } }), captured),
    });
    const verdict = await provider.classify(
      { role: 'user', text: 'text' },
      new AbortController().signal,
    );
    expect(verdict).toEqual({ flagged: true, categories: ['S1'] });
    expect(captured[0]?.body).toMatchObject({
      model: 'llama-guard3:1b',
      stream: false,
      options: { num_ctx: 2048, temperature: 0 },
      messages: [{ role: 'user', content: 'text' }],
    });
  });

  it('classifies an assistant paragraph after a placeholder user turn', async () => {
    const captured: Captured[] = [];
    const provider = createOllamaModerationProvider({
      ...guardBase,
      fetch: fakeFetch(() => Response.json({ message: { content: 'safe' } }), captured),
    });
    await provider.classify({ role: 'assistant', text: 'para' }, new AbortController().signal);
    expect(captured[0]?.body).toMatchObject({
      messages: [{ role: 'user' }, { role: 'assistant', content: 'para' }],
    });
  });

  it('fails closed on an unexpected body', async () => {
    for (const respond of [
      () => Response.json({ nope: true }),
      () => new Response('not json'),
      () => new Response('x', { status: 503 }),
      () => new Response('x'.repeat(70_000)),
      () => new Response(null),
    ]) {
      const provider = createOllamaModerationProvider({ ...guardBase, fetch: fakeFetch(respond) });
      await expect(
        provider.classify({ role: 'user', text: 't' }, new AbortController().signal),
      ).rejects.toBeInstanceOf(ProviderError);
    }
  });
});

describe('Ollama guard residency', () => {
  const guardBase = { ...base, model: 'llama-guard3:1b' };
  const psFetch =
    (respond: () => Response, urls: string[] = []): FetchFn =>
    (url, init) => {
      urls.push(`${init.method ?? ''} ${url}`);
      return Promise.resolve(respond());
    };
  const signal = new AbortController().signal;

  it('reports the guard resident when /api/ps lists it', async () => {
    const urls: string[] = [];
    const provider = createOllamaModerationProvider({
      ...guardBase,
      fetch: psFetch(
        () => Response.json({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama-guard3:1b' }] }),
        urls,
      ),
    });
    expect(await provider.isResident?.(signal)).toBe(true);
    expect(urls).toEqual(['GET http://127.0.0.1:11434/api/ps']);
  });

  it('matches an untagged model against its :latest name', async () => {
    const provider = createOllamaModerationProvider({
      ...base,
      model: 'llama-guard3',
      fetch: psFetch(() => Response.json({ models: [{ name: 'llama-guard3:latest' }] })),
    });
    expect(await provider.isResident?.(signal)).toBe(true);
  });

  it('also matches on the model field', async () => {
    const provider = createOllamaModerationProvider({
      ...guardBase,
      fetch: psFetch(() =>
        Response.json({ models: [{ name: 'guard-alias', model: 'llama-guard3:1b' }] }),
      ),
    });
    expect(await provider.isResident?.(signal)).toBe(true);
  });

  it('counts the guard as resident only at the context size it asks for', async () => {
    const at = (contextLength: number) =>
      createOllamaModerationProvider({
        ...guardBase,
        fetch: psFetch(() =>
          Response.json({ models: [{ name: 'llama-guard3:1b', context_length: contextLength }] }),
        ),
      });
    // Loaded by another client at 4096: Ollama would reload it, so it is not warm.
    expect(await at(4096).isResident?.(signal)).toBe(false);
    expect(await at(2048).isResident?.(signal)).toBe(true);
  });

  it('caps the response size and honours the caller abort', async () => {
    const big = createOllamaModerationProvider({
      ...guardBase,
      fetch: psFetch(() => new Response('x'.repeat(70_000))),
    });
    await expect(big.isResident?.(signal)).rejects.toBeInstanceOf(ProviderError);
    const controller = new AbortController();
    controller.abort();
    const aborted = createOllamaModerationProvider({
      ...guardBase,
      fetch: (_url, init) =>
        init.signal?.aborted === true
          ? Promise.reject(new DOMException('aborted', 'AbortError'))
          : Promise.resolve(Response.json({ models: [] })),
    });
    await expect(aborted.isResident?.(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('reports not resident when only other models are loaded', async () => {
    const provider = createOllamaModerationProvider({
      ...guardBase,
      fetch: psFetch(() => Response.json({ models: [{ name: 'llama-guard3:8b' }] })),
    });
    expect(await provider.isResident?.(signal)).toBe(false);
  });

  it('throws a ProviderError on a failed or malformed answer', async () => {
    for (const respond of [
      () => new Response('x', { status: 500 }),
      () => Response.json({ loaded: [] }),
      () => new Response(null),
    ]) {
      const provider = createOllamaModerationProvider({ ...guardBase, fetch: psFetch(respond) });
      await expect(provider.isResident?.(signal)).rejects.toBeInstanceOf(ProviderError);
    }
    const down = createOllamaModerationProvider({
      ...guardBase,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(down.isResident?.(signal)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('Ollama embedding provider', () => {
  const vector = Array.from({ length: 768 }, (_, i) => i / 768);
  it('embeds texts through /api/embed', async () => {
    const captured: Captured[] = [];
    const provider = createOllamaEmbeddingProvider({
      ...base,
      model: 'nomic-embed-text',
      fetch: fakeFetch(() => Response.json({ embeddings: [vector, vector] }), captured),
    });
    const out = await provider.embed(['a', 'b'], new AbortController().signal);
    expect(out).toHaveLength(2);
    expect(out[0]?.length).toBe(768);
    expect(captured[0]?.url).toBe('http://127.0.0.1:11434/api/embed');
    expect(captured[0]?.body).toMatchObject({ model: 'nomic-embed-text', input: ['a', 'b'] });
  });

  it('rejects a wrong shape', async () => {
    for (const body of [{ embeddings: [[1, 2]] }, { embeddings: [] }, { nope: true }]) {
      const provider = createOllamaEmbeddingProvider({
        ...base,
        model: 'nomic-embed-text',
        fetch: fakeFetch(() => Response.json(body)),
      });
      await expect(provider.embed(['a'], new AbortController().signal)).rejects.toBeInstanceOf(
        ProviderError,
      );
    }
  });
});
