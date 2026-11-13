import type { AccountClient } from '@local-ai/client';
import { describe, expect, it } from 'vitest';

import type { TokenStore } from './session';
import { createSession } from './session';

const signal = new AbortController().signal;

function memoryStore(initial?: string): TokenStore & { value: string | undefined } {
  const store = {
    value: initial,
    get: () => Promise.resolve(store.value),
    set: (token: string) => {
      store.value = token;
      return Promise.resolve();
    },
    clear: () => {
      store.value = undefined;
      return Promise.resolve();
    },
  };
  return store;
}

function account(active: (token: string | undefined) => boolean, seen: string[]) {
  let n = 0;
  const client: Pick<AccountClient, 'hasSession' | 'startSession'> = {
    hasSession: () => Promise.resolve(active(undefined)),
    startSession: () => {
      n += 1;
      seen.push('start');
      return Promise.resolve(String(n).repeat(43));
    },
  };
  return client;
}

describe('mobile session', () => {
  it('reuses a stored token the API still knows', async () => {
    const seen: string[] = [];
    const store = memoryStore('s'.repeat(43));
    const session = createSession(store);
    await session.ensure(
      account(() => true, seen),
      signal,
    );
    expect(session.token()).toBe('s'.repeat(43));
    expect(seen).toEqual([]);
  });

  it('starts and stores a new session when there is none or it expired', async () => {
    const seen: string[] = [];
    const store = memoryStore('old'.padEnd(43, 'x'));
    const session = createSession(store);
    await session.ensure(
      account(() => false, seen),
      signal,
    );
    expect(seen).toEqual(['start']);
    expect(session.token()).toBe('1'.repeat(43));
    expect(store.value).toBe('1'.repeat(43));
  });

  it('forgets the token after everything is deleted', async () => {
    const store = memoryStore('s'.repeat(43));
    const session = createSession(store);
    await session.ensure(
      account(() => true, []),
      signal,
    );
    await session.forget();
    expect(session.token()).toBeUndefined();
    expect(store.value).toBeUndefined();
  });
});
