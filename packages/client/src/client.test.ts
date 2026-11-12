import type { SseEvent } from '@local-ai/contract';
import { encodeSseEvent, sseEventId, ssePing } from '@local-ai/contract';
import { fixtureMessageId, fixtureTurns } from '@local-ai/contract/fixtures';
import { describe, expect, it } from 'vitest';

import type { FetchLike, SseFrame } from './index.js';
import {
  cancelTurn,
  ChatClientError,
  createChatClient,
  failTurn,
  initialTurn,
  maxFrameChars,
  parseSse,
  reduceTurn,
} from './index.js';

const encoder = new TextEncoder();

function streamOf(
  chunks: readonly Uint8Array<ArrayBuffer>[],
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      if (onCancel === undefined) c.close();
    },
    ...(onCancel === undefined ? {} : { cancel: onCancel }),
  });
}

function wire(events: readonly SseEvent[], ping = false): string {
  return events
    .map((e, i) => (ping ? ssePing : '') + encodeSseEvent(e, sseEventId(fixtureMessageId, i)))
    .join('');
}

async function frames(body: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const f of parseSse(body, new AbortController().signal)) out.push(f);
  return out;
}

function sseResponse(text: string | ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(typeof text === 'string' ? text : text, {
    status,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

async function collect(it: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const signal = new AbortController().signal;

describe('SSE contract: the client reads back exactly what the server encodes', () => {
  for (const [name, turn] of Object.entries(fixtureTurns)) {
    it(`round-trips the ${name} turn at every chunk boundary`, async () => {
      const bytes = encoder.encode(wire(turn, true));
      // Every split point, including inside multi-byte characters and CRLF-free frame ends.
      for (let cut = 1; cut < bytes.length; cut += Math.max(1, Math.floor(bytes.length / 97))) {
        const client = createChatClient({
          baseUrl: 'http://api.test',
          fetch: () =>
            Promise.resolve(sseResponse(streamOf([bytes.slice(0, cut), bytes.slice(cut)]))),
        });
        expect(await collect(client.send({ message: 'x' }, signal))).toEqual(turn);
      }
    });
  }

  it('parses byte-by-byte delivery', async () => {
    const turn = fixtureTurns.answered ?? [];
    const bytes = encoder.encode(wire(turn));
    const parsed = await frames(streamOf([...bytes].map((b) => Uint8Array.of(b))));
    expect(parsed.map((f) => JSON.parse(f.data) as unknown)).toEqual(turn);
    expect(parsed.map((f) => f.id)).toEqual(turn.map((_, i) => `${fixtureMessageId}:${String(i)}`));
  });
});

describe('parseSse', () => {
  it('handles CRLF and CR line ends, multi-line data, comments and defaults', async () => {
    const text =
      ': hello\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata:x\r\rid: 7\nevent: b\ndata: y\n\n';
    expect(await frames(streamOf([encoder.encode(text)]))).toEqual([
      { event: 'a', id: undefined, data: 'one\ntwo' },
      { event: 'message', id: undefined, data: 'x' },
      { event: 'b', id: '7', data: 'y' },
    ]);
  });

  it('joins a CRLF split across chunks', async () => {
    const parsed = await frames(streamOf([encoder.encode('data: a\r'), encoder.encode('\n\r\n')]));
    expect(parsed).toEqual([{ event: 'message', id: undefined, data: 'a' }]);
  });

  it('accepts a lone CR as the final line end at the end of the stream', async () => {
    expect(await frames(streamOf([encoder.encode('data: x\r\r')]))).toEqual([
      { event: 'message', id: undefined, data: 'x' },
    ]);
  });

  it('drops a final frame without its blank line, and frames without data', async () => {
    expect(await frames(streamOf([encoder.encode('event: x\n\ndata: cut')]))).toEqual([]);
  });

  it('rejects an oversized frame', async () => {
    const big = `data: ${'x'.repeat(maxFrameChars + 1)}\n`;
    await expect(frames(streamOf([encoder.encode(big)]))).rejects.toThrow('frame too large');
    await expect(frames(streamOf([encoder.encode('x'.repeat(maxFrameChars + 1))]))).rejects.toThrow(
      'line too long',
    );
  });

  it('cancels the stream when the consumer stops early or aborts', async () => {
    let cancelled = 0;
    const body = streamOf([encoder.encode('data: a\n\ndata: b\n\n')], () => cancelled++);
    for await (const f of parseSse(body, signal)) {
      expect(f.data).toBe('a');
      break;
    }
    expect(cancelled).toBe(1);

    const controller = new AbortController();
    const pending = frames2(
      streamOf([], () => cancelled++),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelled).toBe(2);
  });
});

async function frames2(body: ReadableStream<Uint8Array>, s: AbortSignal): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const f of parseSse(body, s)) out.push(f);
  return out;
}

describe('stream timeouts', () => {
  it('fails a silent stream after the idle timeout, retryably', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(wire((fixtureTurns.answered ?? []).slice(0, 2))));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = createChatClient({
      baseUrl: '',
      fetch: () => Promise.resolve(sseResponse(body)),
      idleTimeoutMs: 30,
    });
    const seen: SseEvent[] = [];
    const err: unknown = await (async () => {
      for await (const e of client.send({ message: 'x' }, signal)) seen.push(e);
    })().catch((e: unknown) => e);
    expect(seen).toHaveLength(2);
    expect(err).toMatchObject({ code: 'incomplete', retryable: true });
    expect(cancelled).toBe(true);
  });

  it('keeps a slow stream alive while pings or events keep arriving', async () => {
    const turn = fixtureTurns.refused ?? [];
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        for (const [i, e] of turn.entries()) {
          await new Promise((r) => setTimeout(r, 15));
          c.enqueue(encoder.encode(ssePing + encodeSseEvent(e, sseEventId(fixtureMessageId, i))));
        }
        c.close();
      },
    });
    const client = createChatClient({
      baseUrl: '',
      fetch: () => Promise.resolve(sseResponse(body)),
      idleTimeoutMs: 40,
    });
    expect(await collect(client.send({ message: 'x' }, signal))).toEqual(turn);
  });

  it('times out waiting for headers but not a long body', async () => {
    const hanging = createChatClient({
      baseUrl: '',
      connectTimeoutMs: 20,
      fetch: (_u, init) =>
        new Promise((_r, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new TypeError('aborted'));
          });
        }),
    });
    const err: unknown = await collect(hanging.send({ message: 'x' }, signal)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'network', retryable: true });

    let requestSignal: AbortSignal | undefined;
    const slowBody = createChatClient({
      baseUrl: '',
      connectTimeoutMs: 20,
      fetch: (_u, init) => {
        requestSignal = init.signal ?? undefined;
        const turn = fixtureTurns.refused ?? [];
        return Promise.resolve(
          sseResponse(
            new ReadableStream<Uint8Array>({
              async start(c) {
                await new Promise((r) => setTimeout(r, 60));
                c.enqueue(encoder.encode(wire(turn)));
                c.close();
              },
            }),
          ),
        );
      },
    });
    expect(await collect(slowBody.send({ message: 'x' }, signal))).toHaveLength(4);
    expect(requestSignal?.aborted).toBe(false);
  });
});

describe('chat client', () => {
  it('posts JSON with credentials to /v1/chat', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn: FetchLike = (url, init) => {
      seen = { url, init };
      return Promise.resolve(sseResponse(wire(fixtureTurns.refused ?? [])));
    };
    await collect(
      createChatClient({ baseUrl: 'http://api.test', fetch: fetchFn }).send(
        { message: 'hi' },
        signal,
      ),
    );
    expect(seen?.url).toBe('http://api.test/v1/chat');
    expect(seen?.init).toMatchObject({
      method: 'POST',
      body: '{"message":"hi"}',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    });
  });

  async function errorOf(res: Response | Error): Promise<ChatClientError> {
    const client = createChatClient({
      baseUrl: '',
      fetch: () => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res)),
    });
    const err: unknown = await collect(client.send({ message: 'x' }, signal)).catch(
      (e: unknown) => e,
    );
    if (!(err instanceof ChatClientError)) throw new Error('expected a ChatClientError');
    return err;
  }

  it.each([
    [() => new Response('{}', { status: 400 }), 'rejected', false],
    [() => new Response('{}', { status: 403 }), 'rejected', false],
    [() => new Response('boom', { status: 500 }), 'server', true],
    [
      () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      'protocol',
      false,
    ],
    [() => sseResponse('event: delta\ndata: {"type":"delta","text":"x"}\n\n'), 'incomplete', true],
    [() => sseResponse('event: delta\ndata: not json\n\n'), 'protocol', false],
    [() => sseResponse('event: delta\ndata: {"type":"delta","text":""}\n\n'), 'protocol', false],
    [
      () => sseResponse('event: done\ndata: {"type":"delta","text":"mismatch"}\n\n'),
      'protocol',
      false,
    ],
    [() => sseResponse(`data: ${'x'.repeat(maxFrameChars + 1)}\n`), 'protocol', false],
  ])('maps a bad response to a typed error (%#)', async (make, code, retryable) => {
    const err = await errorOf(make());
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('maps rate limiting and busy, with the retry delay', async () => {
    const limited = await errorOf(
      Response.json({ error: { code: 'rate_limited', retryAfterMs: 4200 } }, { status: 429 }),
    );
    expect(limited).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: 4200 });
    const busy = await errorOf(
      new Response('{}', { status: 503, headers: { 'retry-after': '10' } }),
    );
    expect(busy).toMatchObject({ code: 'busy', retryAfterMs: 10_000 });
    const noHint = await errorOf(new Response('nope', { status: 429 }));
    expect(noHint.retryAfterMs).toBeUndefined();
  });

  it('maps a network failure', async () => {
    expect((await errorOf(new TypeError('fetch failed'))).code).toBe('network');
  });

  it('maps a stream that breaks mid-answer to network', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(wire((fixtureTurns.answered ?? []).slice(0, 2))));
        c.error(new TypeError('socket hang up'));
      },
    });
    expect((await errorOf(sseResponse(body))).code).toBe('network');
  });

  it('rethrows the abort when the caller cancels', async () => {
    const controller = new AbortController();
    const client = createChatClient({
      baseUrl: '',
      fetch: (_u, init) =>
        new Promise((_r, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new TypeError('aborted'));
          });
        }),
    });
    const pending = collect(client.send({ message: 'x' }, controller.signal)).catch(
      (e: unknown) => e,
    );
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(DOMException);
  });
});

describe('turn view', () => {
  const fold = (events: readonly SseEvent[]) => events.reduce(reduceTurn, initialTurn);

  it('builds an answered turn', () => {
    const view = fold(fixtureTurns.answered ?? []);
    expect(view.phase).toBe('done');
    expect(view.text).toBe(
      (fixtureTurns.answered ?? []).flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join(''),
    );
    expect(view.citations).toEqual([{ n: 1, url: 'https://example.com/a?b=c', title: 'Example' }]);
    expect(view.conversationId).toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7');
  });

  it('keeps released paragraphs and the refusal when refused mid-answer', () => {
    const view = fold(fixtureTurns.refusedMidAnswer ?? []);
    expect(view).toMatchObject({ phase: 'refused', text: 'Released before the flag.' });
    expect(view.refusal?.kind).toBe('policy');
  });

  it('records a server error, a length stop, a delivery failure and a cancel', () => {
    expect(fold(fixtureTurns.failed ?? [])).toMatchObject({
      phase: 'failed',
      error: { retryable: true },
    });
    expect(fold([{ type: 'done', finishReason: 'length' }]).truncated).toBe(true);
    expect(failTurn(initialTurn, 'offline', true)).toMatchObject({
      phase: 'failed',
      error: { message: 'offline' },
    });
    expect(cancelTurn(initialTurn).phase).toBe('cancelled');
  });
});
