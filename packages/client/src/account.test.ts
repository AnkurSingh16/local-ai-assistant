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
        return Promise.resolve(new Response(null, { status: seen.length === 1 ? 200 : 401 }));
      },
    });
    expect(await account.hasSession(signal)).toBe(true);
    expect(await account.hasSession(signal)).toBe(false);
    expect(seen[0]).toBe(`Bearer ${'b'.repeat(43)}`);
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
