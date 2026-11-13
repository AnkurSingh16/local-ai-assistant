import { describe, expect, it } from 'vitest';

import type { NativeInit } from './fetch';
import { createFetchLike } from './fetch';

describe('mobile fetch adapter', () => {
  it('never stores or sends cookies, refuses redirects, and passes the rest through', async () => {
    const seen: { input: string; init: NativeInit }[] = [];
    const fetchLike = createFetchLike((input, init) => {
      seen.push({ input, init });
      return Promise.resolve(new Response('{}'));
    });
    const controller = new AbortController();
    await fetchLike('http://api.test/v1/chat', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: '{"message":"hi"}',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const init = seen[0]?.init;
    expect(seen[0]?.input).toBe('http://api.test/v1/chat');
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('error');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"message":"hi"}');
    expect(init?.headers.get('authorization')).toBe('Bearer t');
    expect(init?.signal).toBe(controller.signal);
  });
});
