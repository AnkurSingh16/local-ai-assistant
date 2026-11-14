import { describe, expect, it } from 'vitest';

import { AccountError, createAccountClient } from './account.js';

const signal = new AbortController().signal;

describe('account client', () => {
  it('starts a session and validates the token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const account = createAccountClient({
      baseUrl: 'http://api',
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(Response.json({ token: 'a'.repeat(43) }, { status: 201 }));
      },
    });
    expect(await account.startSession(signal)).toBe('a'.repeat(43));
    expect(calls[0]?.url).toBe('http://api/v1/sessions');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.credentials).toBe('same-origin');
  });

  it('reports whether a session is active, sending the bearer token when it has one', async () => {
    const seen: (string | undefined)[] = [];
    const account = createAccountClient({
      baseUrl: '',
      token: () => 'b'.repeat(43),
      fetch: (_url, init) => {
        const headers = new Headers(init.headers);
        seen.push(headers.get('authorization') ?? undefined);
        return Promise.resolve(Response.json({ active: seen.length === 1 }));
      },
    });
    expect(await account.hasSession(signal)).toBe(true);
    expect(await account.hasSession(signal)).toBe(false);
    expect(seen[0]).toBe(`Bearer ${'b'.repeat(43)}`);
  });

  it('treats an unexpected answer about the session as an error', async () => {
    const odd = createAccountClient({
      baseUrl: '',
      fetch: () => Promise.resolve(Response.json({ active: 'yes' })),
    });
    await expect(odd.hasSession(signal)).rejects.toBeInstanceOf(AccountError);
    const down = createAccountClient({
      baseUrl: '',
      fetch: () => Promise.resolve(new Response(null, { status: 503 })),
    });
    await expect(down.hasSession(signal)).rejects.toBeInstanceOf(AccountError);
  });

  it('throws AccountError on network failure or a bad body', async () => {
    const down = createAccountClient({
      baseUrl: '',
      fetch: () => Promise.reject(new TypeError('x')),
    });
    await expect(down.startSession(signal)).rejects.toBeInstanceOf(AccountError);
    const bad = createAccountClient({
      baseUrl: '',
      fetch: () => Promise.resolve(Response.json({ nope: 1 })),
    });
    await expect(bad.startSession(signal)).rejects.toBeInstanceOf(AccountError);
  });
});

describe('memory and feedback calls', () => {
  it('lists, forgets, deletes everything and sends feedback', async () => {
    const calls: { url: string; method: string | undefined; body: unknown }[] = [];
    const account = createAccountClient({
      baseUrl: '',
      fetch: (url, init) => {
        calls.push({ url, method: init.method, body: init.body });
        if (url === '/v1/me/memory') {
          return Promise.resolve(
            Response.json({
              items: [{ id: 'm1', content: 'Call me Sam.', createdAt: '2026-11-13T00:00:00.000Z' }],
            }),
          );
        }
        return Promise.resolve(new Response(null, { status: url === '/v1/feedback' ? 202 : 204 }));
      },
    });
    const listed = await account.memory(signal);
    expect(listed.map((m) => m.content)).toEqual(['Call me Sam.']);
    // An older API sends no always flag; the client reads it as false.
    expect(listed.map((m) => m.always)).toEqual([false]);
    await account.forget('m 1', signal);
    await account.deleteEverything(signal);
    await account.sendFeedback('preference', 'Use metric.', signal);
    expect(calls.map((c) => `${c.method ?? ''} ${c.url}`)).toEqual([
      'GET /v1/me/memory',
      'DELETE /v1/me/memory/m%201',
      'DELETE /v1/me',
      'POST /v1/feedback',
    ]);
    expect(calls[3]?.body).toBe(JSON.stringify({ kind: 'preference', text: 'Use metric.' }));
  });

  it('throws AccountError on a failed call', async () => {
    const account = createAccountClient({
      baseUrl: '',
      fetch: () => Promise.resolve(new Response(null, { status: 401 })),
    });
    await expect(account.memory(signal)).rejects.toMatchObject({ status: 401 });
  });
});
