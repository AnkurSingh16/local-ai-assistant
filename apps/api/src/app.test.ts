import { createAssistant } from '@local-ai/agent';
import type { ManualClock } from '@local-ai/core';
import { createManualClock } from '@local-ai/core';
import type { SseEvent } from '@local-ai/contract';
import { sseEventSchema } from '@local-ai/contract';
import {
  createConversationRepo,
  createFlagLog,
  createMemoryRepo,
  createReviewRepo,
  createSessionRepo,
  openDatabase,
} from '@local-ai/storage';
import { createInputGuard, createOutputGuard, createOutputRules } from '@local-ai/guardrails';
import type { MockChatProvider, MockModerationOptions } from '@local-ai/providers/mock';
import {
  createMockChatProvider,
  createMockModerationProvider,
  mockReply,
} from '@local-ai/providers/mock';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppDeps } from './app.js';
import { bodyLimitBytes, createApp } from './app.js';
import { trackReadiness } from './compose.js';
import { createFeedbackService } from './learning.js';
import { createSessionService } from './sessions.js';
import { parseConfig } from './config.js';
import { createLogEvent } from './logging.js';

const host = 'localhost:8787';
const marker = 'ZQX-PRIVATE-MARKER-7731';

interface Harness {
  app: FastifyInstance;
  chat: MockChatProvider;
  clock: ManualClock;
  logs: string[];
  routes: { method: string; url: string }[];
  db?: ReturnType<typeof openDatabase>;
}

let open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.map((a) => a.close()));
  open = [];
});

async function harness(
  options: {
    env?: Record<string, string>;
    chat?: MockChatProvider;
    moderation?: MockModerationOptions;
    deps?: Partial<AppDeps>;
    storage?: boolean;
  } = {},
): Promise<Harness> {
  const config = parseConfig({ NODE_ENV: 'test', ...options.env });
  const clock = createManualClock(new Date('2026-11-12T00:00:00Z'));
  const chat =
    options.chat ?? createMockChatProvider({ reply: (req) => mockReply('One.\n\nTwo.', req) });
  const moderation = createMockModerationProvider(options.moderation);
  let n = 0;
  const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const logs: string[] = [];
  const logger = pino(
    { level: 'trace' },
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        logs.push(chunk.toString());
        cb();
      },
    }),
  );
  const routes: { method: string; url: string }[] = [];
  const db = options.storage === true ? openDatabase(':memory:') : undefined;
  const conversations = db === undefined ? undefined : createConversationRepo({ db, clock, newId });
  const sessions =
    db === undefined || conversations === undefined
      ? undefined
      : createSessionService({
          sessions: createSessionRepo({ db, clock, newId }),
          conversations,
          memory: createMemoryRepo({ db, clock, newId }),
        });
  const feedback =
    db === undefined
      ? undefined
      : createFeedbackService({
          inputGuard: createInputGuard({ moderation, timeoutMs: 1000 }),
          review: createReviewRepo({ db, clock, newId }),
          flags: createFlagLog({ db, clock, newId }),
        });
  const app = await createApp({
    config,
    clock,
    logger,
    logEvent: createLogEvent(logger),
    newId,
    isReady: () => true,
    onRoute: (r) => routes.push(r),
    assistant: createAssistant({
      chat,
      inputGuard: createInputGuard({ moderation, timeoutMs: 1000 }),
      outputGuard: createOutputGuard({
        moderation,
        timeoutMs: 1000,
        rules: createOutputRules({ systemPrompt: 'Test persona.' }),
      }),
      newId,
      turnTimeoutMs: 5000,
      clock,
      ...(conversations === undefined ? {} : { conversations }),
    }),
    ...(sessions === undefined ? {} : { sessions }),
    ...(feedback === undefined ? {} : { feedback }),
    ...options.deps,
  });
  open.push(app);
  return { app, chat, clock, logs, routes, ...(db === undefined ? {} : { db }) };
}

function post(app: FastifyInstance, body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat',
    headers: { host, 'content-type': 'application/json', ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function parseFrames(payload: string): { id: string; event: SseEvent }[] {
  return payload
    .split('\n\n')
    .filter((f) => f.startsWith('event:'))
    .map((frame) => {
      const fields = Object.fromEntries(
        frame.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]),
      ) as Record<string, string>;
      return { id: fields.id ?? '', event: sseEventSchema.parse(JSON.parse(fields.data ?? '')) };
    });
}

describe('POST /v1/chat', () => {
  it('streams the turn as SSE with sequenced ids', async () => {
    const { app } = await harness();
    const res = await post(app, { message: 'Hello' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    const frames = parseFrames(res.payload);
    expect(frames.map((f) => f.event.type)).toEqual([
      'meta',
      'status',
      'status',
      'delta',
      'delta',
      'done',
    ]);
    const messageId = frames[0]?.event.type === 'meta' ? frames[0].event.messageId : '';
    expect(frames.map((f) => f.id)).toEqual(frames.map((_, i) => `${messageId}:${String(i)}`));
  });

  it('rejects an invalid body with a JSON error', async () => {
    const { app, chat } = await harness();
    const res = await post(app, { message: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        code: 'bad_request',
        message: expect.any(String) as string,
        requestId: expect.any(String) as string,
      },
    });
    expect(chat.calls).toHaveLength(0);
  });

  it.each([
    ['text/plain', 'hello'],
    ['application/x-www-form-urlencoded', 'message=hello'],
  ])('refuses %s bodies with 415', async (type, payload) => {
    const { app } = await harness();
    const res = await post(app, payload, { 'content-type': type });
    expect(res.statusCode).toBe(415);
  });

  it('refuses bodies over the limit with 413', async () => {
    const { app } = await harness();
    const res = await post(app, { message: 'x'.repeat(bodyLimitBytes) });
    expect(res.statusCode).toBe(413);
  });

  it('refuses malformed JSON with 400', async () => {
    const { app } = await harness();
    expect((await post(app, '{"message":')).statusCode).toBe(400);
  });

  it('rate-limits per IP and recovers after the window', async () => {
    const { app, clock } = await harness({
      env: { RATE_LIMIT_PER_IP: '2', RATE_LIMIT_WINDOW_MS: '60000' },
    });
    expect((await post(app, { message: 'a' })).statusCode).toBe(200);
    expect((await post(app, { message: 'b' })).statusCode).toBe(200);
    const limited = await post(app, { message: 'c' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    clock.advance(60_001);
    expect((await post(app, { message: 'd' })).statusCode).toBe(200);
  });

  it('answers 503 with Retry-After when the turn queue is full', async () => {
    const { app } = await harness({
      env: { MAX_CONCURRENT_TURNS: '1', MAX_QUEUED_TURNS: '0' },
      chat: createMockChatProvider({ delayMs: 30 }),
    });
    const first = post(app, { message: 'slow' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await post(app, { message: 'next' });
    expect(second.statusCode).toBe(503);
    expect(second.headers['retry-after']).toBe('10');
    expect((await first).statusCode).toBe(200);
  });

  it('queues a turn until a slot frees', async () => {
    const { app } = await harness({
      env: { MAX_CONCURRENT_TURNS: '1', MAX_QUEUED_TURNS: '1' },
      chat: createMockChatProvider({ delayMs: 5 }),
    });
    const [a, b] = await Promise.all([post(app, { message: 'a' }), post(app, { message: 'b' })]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
  });

  it('sends keep-alive pings on a slow stream', async () => {
    const { app } = await harness({
      chat: createMockChatProvider({ delayMs: 15 }),
      deps: { pingIntervalMs: 5 },
    });
    const res = await post(app, { message: 'Hello' });
    expect(res.payload).toContain(': ping\n\n');
  });
});

describe('request checks', () => {
  it('refuses a Host header outside the allowlist, before anything else', async () => {
    const { app, chat } = await harness();
    const res = await post(app, { message: 'Hello' }, { host: 'evil.example:8787' });
    expect(res.statusCode).toBe(403);
    expect(chat.calls).toHaveLength(0);
  });

  it('refuses a disallowed Origin', async () => {
    const { app } = await harness();
    const res = await post(app, { message: 'Hello' }, { origin: 'http://localhost:3000' });
    expect(res.statusCode).toBe(403);
  });

  it('allows the configured Origin, with CORS headers on the stream', async () => {
    const { app } = await harness();
    const res = await post(app, { message: 'Hello' }, { origin: 'http://localhost:5173' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('answers a CORS preflight for an allowed origin', async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/chat',
      headers: {
        host,
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/nope', headers: { host } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('health', () => {
  it('reports liveness and readiness', async () => {
    let ready = false;
    const { app } = await harness({ deps: { isReady: () => ready } });
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { host } });
    expect((await get('/healthz')).json()).toEqual({ status: 'ok' });
    expect((await get('/readyz')).statusCode).toBe(503);
    ready = true;
    expect((await get('/readyz')).json()).toEqual({ status: 'ready' });
  });
});

describe('route inventory (ADR-0002)', () => {
  it('never reaches the chat model from any POST route when moderation flags everything', async () => {
    const { app, chat, routes } = await harness({
      moderation: { classify: () => ({ flagged: true, categories: ['S1'] }) },
    });
    await app.ready();
    const posts = routes.filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.url)).toEqual(['/v1/chat']);
    for (const route of posts) {
      const res = await app.inject({
        method: 'POST',
        url: route.url,
        headers: { host, 'content-type': 'application/json' },
        payload: JSON.stringify({ message: 'hello' }),
      });
      expect(res.statusCode).toBeLessThan(500);
    }
    expect(chat.calls).toHaveLength(0);
  });
});

describe('logging (ADR-0013)', () => {
  it('never logs message text, on success, refusal or error', async () => {
    const { app, logs } = await harness({
      moderation: {
        classify: (input) =>
          input.text.includes('refuse')
            ? { flagged: true, categories: ['S1'] }
            : { flagged: false },
      },
    });
    await post(app, { message: `hello ${marker}` });
    await post(app, { message: `refuse ${marker}` });
    await post(app, { message: marker, extra: marker });
    await post(app, `{"message":"${marker}`);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(marker);
    expect(logs.join('\n')).toContain('turn_completed');
  });
});

describe('client disconnect', () => {
  it('aborts the turn when the client goes away', async () => {
    let chatSignal: AbortSignal | undefined;
    const slow = createMockChatProvider({ delayMs: 50 });
    // fetch cannot set Host, so the real host:port must be on the allowlist.
    const port = 18787;
    const { app, logs } = await harness({
      env: { ALLOWED_HOSTS: `127.0.0.1:${String(port)}` },
      chat: {
        calls: slow.calls,
        chat: (req, signal) => {
          chatSignal = signal;
          return slow.chat(req, signal);
        },
      },
    });
    await app.listen({ host: '127.0.0.1', port });
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${String(port)}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    await reader?.read();
    controller.abort();
    await expect.poll(() => chatSignal?.aborted, { timeout: 2000 }).toBe(true);
    await expect
      .poll(() => logs.some((l) => l.includes('"clientAborted":true')), { timeout: 2000 })
      .toBe(true);
  });
});

describe('readiness tracking', () => {
  it('becomes ready on the first successful classification, not on a failure', async () => {
    let fail = true;
    const tracked = trackReadiness(
      createMockModerationProvider({
        classify: () => {
          if (fail) throw new Error('loading');
          return { flagged: false };
        },
      }),
    );
    const signal = new AbortController().signal;
    await expect(
      tracked.moderation.classify({ role: 'user', text: 'x' }, signal),
    ).rejects.toThrow();
    expect(tracked.isReady()).toBe(false);
    fail = false;
    await tracked.moderation.classify({ role: 'user', text: 'x' }, signal);
    expect(tracked.isReady()).toBe(true);
  });

  it('keeps the residency check, so the warm timeout still applies', async () => {
    const tracked = trackReadiness(createMockModerationProvider({ resident: false }));
    expect(await tracked.moderation.isResident?.(new AbortController().signal)).toBe(false);
  });
});

describe('sessions and conversation memory', () => {
  function cookieFrom(res: { headers: Record<string, unknown> }): string {
    const raw = res.headers['set-cookie'];
    const header = Array.isArray(raw) ? String(raw[0]) : String(raw);
    return header.split(';')[0] ?? '';
  }

  it('rate-limits each session on its own, as well as each address', async () => {
    const { app, clock } = await harness({
      storage: true,
      env: { RATE_LIMIT_PER_SESSION: '2', RATE_LIMIT_PER_IP: '10', RATE_LIMIT_WINDOW_MS: '60000' },
    });
    const start = () => app.inject({ method: 'POST', url: '/v1/sessions', headers: { host } });
    const a = cookieFrom(await start());
    const b = cookieFrom(await start());
    expect((await post(app, { message: '1' }, { cookie: a })).statusCode).toBe(200);
    expect((await post(app, { message: '2' }, { cookie: a })).statusCode).toBe(200);
    const limited = await post(app, { message: '3' }, { cookie: a });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // The same address with another session still has its own budget.
    expect((await post(app, { message: '1' }, { cookie: b })).statusCode).toBe(200);
    clock.advance(60_001);
    expect((await post(app, { message: '4' }, { cookie: a })).statusCode).toBe(200);
  });

  it('creates a session with an HttpOnly, SameSite=Strict cookie and returns the token', async () => {
    const { app } = await harness({ storage: true });
    const res = await app.inject({ method: 'POST', url: '/v1/sessions', headers: { host } });
    expect(res.statusCode).toBe(201);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(JSON.parse(res.body)).toHaveProperty('token');
  });

  it('remembers a conversation for its session, so the next turn sees the history', async () => {
    const { app, chat } = await harness({ storage: true });
    const cookie = cookieFrom(
      await app.inject({ method: 'POST', url: '/v1/sessions', headers: { host } }),
    );
    const first = await post(app, { message: 'My name is Sam.' }, { cookie });
    const conversationId = /"conversationId":"([^"]+)"/.exec(first.body)?.[1] ?? '';
    await post(app, { message: 'What is my name?', conversationId }, { cookie });
    const second = chat.calls[1]?.messages.map((m) => `${m.role}:${m.content}`) ?? [];
    expect(second).toContain('user:My name is Sam.');
    expect(second).toContain('assistant:One.\n\nTwo.');
    expect(second.at(-1)).toBe('user:What is my name?');
  });

  it('accepts a bearer token and refuses another session’s conversation', async () => {
    const { app } = await harness({ storage: true });
    const tokenA = (
      JSON.parse(
        (await app.inject({ method: 'POST', url: '/v1/sessions', headers: { host } })).body,
      ) as { token: string }
    ).token;
    const tokenB = (
      JSON.parse(
        (await app.inject({ method: 'POST', url: '/v1/sessions', headers: { host } })).body,
      ) as { token: string }
    ).token;
    const first = await post(app, { message: 'Hello.' }, { authorization: `Bearer ${tokenA}` });
    const conversationId = /"conversationId":"([^"]+)"/.exec(first.body)?.[1] ?? '';
    const stolen = await post(
      app,
      { message: 'Hi.', conversationId },
      { authorization: `Bearer ${tokenB}` },
    );
    expect(stolen.statusCode).toBe(404);
  });

  it('tells a client whether its session is active', async () => {
    const { app } = await harness({ storage: true });
    const none = await app.inject({ method: 'GET', url: '/v1/me', headers: { host } });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ active: false });
    const cookie = cookieFrom(
      await app.inject({ method: 'POST', url: '/v1/sessions', headers: { host } }),
    );
    expect(
      (await app.inject({ method: 'GET', url: '/v1/me', headers: { host, cookie } })).json(),
    ).toEqual({ active: true });
  });

  it('takes feedback only with a session and answers the same whether it is queued or dropped', async () => {
    const { app } = await harness({ storage: true });
    const send = (payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/v1/feedback',
        headers: { host, 'content-type': 'application/json', ...headers },
        payload: JSON.stringify(payload),
      });
    expect((await send({ kind: 'feedback', text: 'Nice.' })).statusCode).toBe(401);
    const cookie = cookieFrom(
      await app.inject({ method: 'POST', url: '/v1/sessions', headers: { host } }),
    );
    expect((await send({ kind: 'nope', text: 'x' }, { cookie })).statusCode).toBe(400);
    const queued = await send({ kind: 'preference', text: 'Use metric units.' }, { cookie });
    const dropped = await send({ kind: 'feedback', text: 'MOCK_FLAG awful' }, { cookie });
    expect(queued.statusCode).toBe(202);
    expect(dropped.statusCode).toBe(202);
    expect(dropped.body).toBe(queued.body);
    const crisis = await send({ kind: 'feedback', text: 'MOCK_FLAG_SELF_HARM' }, { cookie });
    expect(crisis.statusCode).toBe(202);
    expect(crisis.json<{ message?: string }>().message).toContain('988');
  });

  it('shows remembered items and deletes one, or everything, for real', async () => {
    const { app, db, clock } = await harness({ storage: true });
    if (db === undefined) throw new Error('no db');
    const login = await app.inject({ method: 'POST', url: '/v1/sessions', headers: { host } });
    const cookie = cookieFrom(login);
    const token = (JSON.parse(login.body) as { token: string }).token;
    const sessionId =
      (await createSessionService({
        sessions: createSessionRepo({ db, clock, newId: () => 'x' }),
        conversations: createConversationRepo({ db, clock, newId: () => 'x' }),
        memory: createMemoryRepo({ db, clock, newId: () => 'x' }),
      }).resolve(token)) ?? '';
    const guard = createInputGuard({ moderation: createMockModerationProvider(), timeoutMs: 1000 });
    let memoryIds = 0;
    const memory = createMemoryRepo({ db, clock, newId: () => `m-${String(++memoryIds)}` });
    for (const text of ['Call me Sam.', 'Prefers metric units.']) {
      const verdict = await guard.check(text, new AbortController().signal);
      if (!verdict.ok) throw new Error('refused');
      await memory.add(sessionId, verdict.text, undefined);
    }
    await post(app, { message: 'Hello there.' }, { cookie });

    const list = await app.inject({
      method: 'GET',
      url: '/v1/me/memory',
      headers: { host, cookie },
    });
    const items = (JSON.parse(list.body) as { items: { id: string; content: string }[] }).items;
    expect(items.map((i) => i.content)).toEqual(['Call me Sam.', 'Prefers metric units.']);

    const first = items[0]?.id ?? '';
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/me/memory/${first}`,
          headers: { host, cookie },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/me/memory/${first}`,
          headers: { host, cookie },
        })
      ).statusCode,
    ).toBe(404);

    const gone = await app.inject({ method: 'DELETE', url: '/v1/me', headers: { host, cookie } });
    expect(gone.statusCode).toBe(204);
    expect(String(gone.headers['set-cookie'])).toContain('lai_session=;');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/me', headers: { host, cookie } })).json(),
    ).toEqual({ active: false });
    for (const table of ['sessions', 'conversations', 'messages', 'memory', 'review_items']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
  });

  it('refuses memory calls without a session', async () => {
    const { app } = await harness({ storage: true });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/me/memory', headers: { host } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'DELETE', url: '/v1/me', headers: { host } })).statusCode,
    ).toBe(401);
  });

  it('stays stateless without a session', async () => {
    const { app, chat } = await harness({ storage: true });
    await post(app, { message: 'First.' });
    await post(app, { message: 'Second.' });
    expect(chat.calls[1]?.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });
});
