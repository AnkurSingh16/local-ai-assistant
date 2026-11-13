import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';

import { parseConfig } from './config.js';
import type { DoctorFetch } from './doctor.js';
import { checkOllama, checkPortFree, checkSearxng, format, versionAtLeast } from './doctor.js';

const config = parseConfig({});

function fakeFetch(routes: Record<string, unknown>): DoctorFetch {
  return (url) => {
    const path = new URL(url).pathname;
    if (!(path in routes)) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(Response.json(routes[path]));
  };
}

const goodTags = {
  models: [
    {
      name: 'qwen2.5:7b',
      digest: '845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e',
    },
    {
      name: 'llama-guard3:1b',
      digest: '494147e06bf99e10dbe67b63a07ac81c162f18ef3341aa3390007ac828571b3b',
    },
    {
      name: 'nomic-embed-text:latest',
      digest: '0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f',
    },
  ],
};

describe('doctor', () => {
  it('compares versions numerically', () => {
    expect(versionAtLeast('0.40.15', '0.40.15')).toBe(true);
    expect(versionAtLeast('0.41.0', '0.40.15')).toBe(true);
    expect(versionAtLeast('0.9.9', '0.40.15')).toBe(false);
    expect(versionAtLeast('0.40.15-rc1', '0.40.15')).toBe(false);
    expect(versionAtLeast('0.40.16-rc1', '0.40.15')).toBe(true);
    expect(versionAtLeast('unknown', '0.40.15')).toBe(false);
  });

  it('passes with a current Ollama and the pinned models', async () => {
    const results = await checkOllama(
      config,
      fakeFetch({ '/api/version': { version: '0.40.15' }, '/api/tags': goodTags }),
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('says how to start Ollama when it is not running', async () => {
    const [result] = await checkOllama(config, fakeFetch({}));
    expect(result).toMatchObject({
      ok: false,
      fix: expect.stringContaining('ollama serve') as string,
    });
  });

  it('flags an old Ollama, a missing model and a changed digest, each with a fix', async () => {
    const results = await checkOllama(
      config,
      fakeFetch({
        '/api/version': { version: '0.30.0' },
        '/api/tags': { models: [{ name: 'qwen2.5:7b', digest: 'ffffffffffff' }] },
      }),
    );
    expect(results.filter((r) => !r.ok).map((r) => r.fix)).toEqual([
      'Update Ollama from https://ollama.com/download',
      expect.stringContaining('ollama pull qwen2.5:7b') as string,
      'ollama pull llama-guard3:1b',
      'ollama pull nomic-embed-text',
    ]);
    expect(format(results)).toContain('FAIL');
  });

  it('reports when the model list cannot be read', async () => {
    const results = await checkOllama(
      config,
      fakeFetch({ '/api/version': { version: '0.40.15' } }),
    );
    expect(results.at(-1)).toMatchObject({ ok: false, name: 'Models' });
  });

  it('detects a busy port', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    expect((await checkPortFree('127.0.0.1', port, 'API')).ok).toBe(false);
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
    expect((await checkPortFree('127.0.0.1', port, 'API')).ok).toBe(true);
  });
});

describe('SearXNG check', () => {
  const config = parseConfig({});
  it('passes when the health endpoint answers', async () => {
    const urls: string[] = [];
    const fetchFn: DoctorFetch = (url) => {
      urls.push(url);
      return Promise.resolve(new Response('OK'));
    };
    expect((await checkSearxng(config, fetchFn)).ok).toBe(true);
    expect(urls).toEqual(['http://127.0.0.1:8888/healthz']);
  });

  it('fails with the command that starts it', async () => {
    const down: DoctorFetch = () => Promise.reject(new TypeError('fetch failed'));
    const result = await checkSearxng(config, down);
    expect(result.ok).toBe(false);
    expect(result.fix).toContain('npm run searxng:up');
    const bad: DoctorFetch = () => Promise.resolve(new Response('x', { status: 502 }));
    expect((await checkSearxng(config, bad)).ok).toBe(false);
  });
});
