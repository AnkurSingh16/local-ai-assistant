import type { LookupAddress } from 'node:dns';

import { createManualClock } from '@local-ai/core';
import { describe, expect, it } from 'vitest';

import { createTtlCache } from './cache.js';
import { createPageParser } from './parse.js';
import { createReadPage } from './read-page.js';
import type { HopFetch, HopResponse, Resolve } from './safe-fetch.js';
import {
  checkUrl,
  createGuardedLookup,
  createSafeFetch,
  isPublicAddress,
  SafeFetchFailure,
} from './safe-fetch.js';

const signal = new AbortController().signal;

const publicResolve: Resolve = () => Promise.resolve([{ address: '93.184.215.14', family: 4 }]);

/** Adapts a global Response to the reader interface safeFetch reads. */
function toHop(r: Response): HopResponse {
  const body = r.body;
  return {
    status: r.status,
    ok: r.ok,
    headers: r.headers,
    body:
      body === null
        ? null
        : {
            getReader: () => body.getReader(),
            cancel: (reason?: unknown) => body.cancel(reason),
          },
  };
}

function response(
  status: number,
  body: string,
  headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' },
): HopResponse {
  return toHop(new Response(status >= 300 && status < 400 ? null : body, { status, headers }));
}

function hopFrom(routes: Record<string, () => HopResponse>, seen: string[] = []): HopFetch {
  return (url) => {
    seen.push(url);
    const route = routes[url];
    if (route === undefined) return Promise.reject(new TypeError(`no route ${url}`));
    return Promise.resolve(route());
  };
}

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1',
    'not an ip',
  ])('rejects %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.215.14', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946'])(
    'accepts %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe('checkUrl', () => {
  it.each([
    'http://example.com/',
    'ftp://example.com/',
    'https://example.com:8443/',
    'https://user:pass@example.com/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://2130706433/',
    'https://localhost/',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => checkUrl(url)).toThrow(SafeFetchFailure);
  });

  it('accepts an https URL on the default port', () => {
    expect(checkUrl('https://example.com:443/a?b=1').toString()).toBe('https://example.com/a?b=1');
  });
});

describe('safeFetch', () => {
  it('fetches an allowed page and decodes it', async () => {
    const safeFetch = createSafeFetch({
      resolve: publicResolve,
      hop: hopFrom({ 'https://example.com/': () => response(200, '<p>héllo</p>') }),
    });
    const page = await safeFetch('https://example.com/', signal);
    expect(page).toEqual({
      url: 'https://example.com/',
      contentType: 'text/html',
      body: '<p>héllo</p>',
    });
  });

  it('blocks a host that resolves to any private address', async () => {
    const safeFetch = createSafeFetch({
      resolve: () =>
        Promise.resolve([
          { address: '93.184.215.14', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ]),
      hop: hopFrom({}),
    });
    await expect(safeFetch('https://rebind.example/', signal)).rejects.toMatchObject({
      reason: 'blocked_address',
    });
  });

  it('re-checks every redirect and refuses one to a private host or to http', async () => {
    const seen: string[] = [];
    const resolve: Resolve = (host) =>
      Promise.resolve([
        { address: host === 'internal.example' ? '192.168.0.10' : '93.184.215.14', family: 4 },
      ]);
    const safeFetch = createSafeFetch({
      resolve,
      hop: hopFrom(
        {
          'https://a.example/': () =>
            response(302, '', { location: 'https://internal.example/admin' }),
          'https://b.example/': () => response(301, '', { location: 'http://b.example/plain' }),
        },
        seen,
      ),
    });
    await expect(safeFetch('https://a.example/', signal)).rejects.toMatchObject({
      reason: 'blocked_address',
    });
    await expect(safeFetch('https://b.example/', signal)).rejects.toMatchObject({
      reason: 'invalid_url',
    });
    expect(seen).toEqual(['https://a.example/', 'https://b.example/']);
  });

  it('follows at most three redirects', async () => {
    const routes: Record<string, () => HopResponse> = {};
    for (let i = 0; i < 5; i++) {
      routes[`https://r${String(i)}.example/`] = () =>
        response(302, '', { location: `https://r${String(i + 1)}.example/` });
    }
    const safeFetch = createSafeFetch({ resolve: publicResolve, hop: hopFrom(routes) });
    await expect(safeFetch('https://r0.example/', signal)).rejects.toMatchObject({
      reason: 'too_many_redirects',
    });
  });

  it('cuts off a body over the limit and refuses other content types', async () => {
    const safeFetch = createSafeFetch({
      resolve: publicResolve,
      maxBytes: 100,
      hop: hopFrom({
        'https://big.example/': () => response(200, 'x'.repeat(500)),
        'https://pdf.example/': () => response(200, '%PDF', { 'content-type': 'application/pdf' }),
        'https://gone.example/': () => response(404, 'nope'),
      }),
    });
    await expect(safeFetch('https://big.example/', signal)).rejects.toMatchObject({
      reason: 'too_large',
    });
    await expect(safeFetch('https://pdf.example/', signal)).rejects.toMatchObject({
      reason: 'unsupported_type',
    });
    await expect(safeFetch('https://gone.example/', signal)).rejects.toMatchObject({
      reason: 'http_error',
    });
  });

  it('times out a slow hop', async () => {
    const safeFetch = createSafeFetch({
      resolve: publicResolve,
      timeoutMs: 20,
      hop: (_url, s) =>
        new Promise((_, reject) => {
          s.addEventListener('abort', () => {
            reject(new DOMException('timed out', 'TimeoutError'));
          });
        }),
    });
    await expect(safeFetch('https://slow.example/', signal)).rejects.toMatchObject({
      reason: 'timeout',
    });
  });
});

describe('guarded lookup', () => {
  const run = (
    resolve: Resolve,
    all: boolean,
  ): Promise<{ err: unknown; address: string | LookupAddress[] }> =>
    new Promise((done) => {
      createGuardedLookup(resolve)('host.example', { all }, (err, address) => {
        done({ err, address });
      });
    });

  it('passes public addresses to the connector', async () => {
    expect((await run(publicResolve, false)).address).toBe('93.184.215.14');
    expect((await run(publicResolve, true)).address).toEqual([
      { address: '93.184.215.14', family: 4 },
    ]);
  });

  it('fails the connection when the answer has changed to a private address', async () => {
    const result = await run(() => Promise.resolve([{ address: '127.0.0.1', family: 4 }]), false);
    expect(result.err).toBeInstanceOf(Error);
  });
});

describe('page parser', () => {
  const parse = createPageParser();

  it('extracts the article text and title in a worker, without running scripts', async () => {
    const html = `<html><head><title>Release notes</title></head><body>
      <nav>Home | About</nav>
      <article><h1>Node 24 released</h1>
      <p>${'Node 24 brings a new version of V8 and many other improvements to the runtime. '.repeat(8)}</p>
      <script>document.body.innerHTML = 'hacked'</script></article></body></html>`;
    const page = await parse(
      { url: 'https://example.com/', contentType: 'text/html', body: html },
      signal,
    );
    expect(page.title).toContain('Release notes');
    expect(page.text).toContain('Node 24 brings a new version of V8');
    expect(page.text).not.toContain('hacked');
  });

  it('cuts the text to the limit and passes plain text through', async () => {
    const small = createPageParser({ maxChars: 50 });
    const page = await small(
      { url: 'https://example.com/a.txt', contentType: 'text/plain', body: 'word '.repeat(100) },
      signal,
    );
    expect(page.text.length).toBeLessThanOrEqual(50);
  });
});

describe('read_page tool', () => {
  const cache = () =>
    createTtlCache<{ url: string; title: string; text: string }>({
      clock: createManualClock(new Date('2026-11-13T00:00:00Z')),
      ttlMs: 3_600_000,
      maxEntries: 10,
      hmacKey: new Uint8Array(32),
    });
  const allowed = new Set(['https://example.com/']);
  const fetchOk = createSafeFetch({
    resolve: publicResolve,
    hop: hopFrom({ 'https://example.com/': () => response(200, '<p>Hello there, reader.</p>') }),
  });

  it('reads a page from this turn’s results', async () => {
    const tool = createReadPage({ fetch: fetchOk, parse: createPageParser(), cache: cache() });
    const outcome = await tool.run({ url: 'https://example.com/' }, allowed, signal);
    expect(outcome.ok && outcome.text).toContain('Hello there');
  });

  it('refuses a URL that was not in the results, and invalid arguments', async () => {
    const tool = createReadPage({ fetch: fetchOk, parse: createPageParser(), cache: cache() });
    expect(await tool.run({ url: 'https://evil.example/?q=secret' }, allowed, signal)).toEqual({
      ok: false,
      error: 'not_allowed',
    });
    expect(await tool.run({ href: 'x' }, allowed, signal)).toEqual({
      ok: false,
      error: 'invalid_arguments',
    });
  });

  it('turns fetch failures into an error result for the model', async () => {
    const blocked = createSafeFetch({
      resolve: () => Promise.resolve([{ address: '10.0.0.1', family: 4 }]),
      hop: hopFrom({}),
    });
    const tool = createReadPage({ fetch: blocked, parse: createPageParser(), cache: cache() });
    expect(await tool.run({ url: 'https://example.com/' }, allowed, signal)).toEqual({
      ok: false,
      error: 'blocked_address',
    });
  });
});
