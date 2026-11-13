import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig } from './config.js';

describe('config', () => {
  it('has safe defaults: loopback, Ollama, the 16 GB models', () => {
    const c = parseConfig({});
    expect(c).toMatchObject({
      host: '127.0.0.1',
      port: 8787,
      providers: 'ollama',
      chatModel: 'qwen2.5:7b',
      guardModel: 'llama-guard3:1b',
      allowedHosts: ['localhost:8787', '127.0.0.1:8787'],
      maxConcurrentTurns: 2,
      maxQueuedTurns: 4,
    });
  });

  it('parses lists and numbers', () => {
    const c = parseConfig({ PORT: '9000', ALLOWED_ORIGINS: 'http://a.test, http://b.test,' });
    expect(c.allowedHosts).toEqual(['localhost:9000', '127.0.0.1:9000']);
    expect(c.allowedOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('names every invalid variable without echoing values', () => {
    try {
      parseConfig({ PORT: 'secret-ish', OLLAMA_KEEP_ALIVE: 'forever' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).variables).toEqual(['PORT', 'OLLAMA_KEEP_ALIVE']);
      expect((err as ConfigError).message).not.toContain('secret-ish');
    }
  });

  it('refuses mock providers in production', () => {
    expect(() => parseConfig({ NODE_ENV: 'production', PROVIDERS: 'mock' })).toThrow(ConfigError);
  });
});

describe('SearXNG address', () => {
  it('accepts loopback and refuses any other host', () => {
    expect(parseConfig({ SEARXNG_URL: 'http://localhost:8888' }).searxngUrl).toBe(
      'http://localhost:8888',
    );
    expect(() => parseConfig({ SEARXNG_URL: 'http://searx.example.org' })).toThrow();
  });
});
