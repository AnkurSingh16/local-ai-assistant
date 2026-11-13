import type { FetchLike } from '@local-ai/client';

/** The parts of expo/fetch's RequestInit this app sets. */
export interface NativeInit {
  readonly method?: string;
  readonly headers: Headers;
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly credentials: 'omit';
  readonly redirect: 'error';
}

/**
 * Adapts expo/fetch to the shared client. Two settings matter for the session
 * token (ADR-0009): `credentials: 'omit'`, because expo/fetch otherwise keeps
 * the API's Set-Cookie in the native cookie jar, an ordinary on-disk store,
 * and sends it back; and `redirect: 'error'`, so the bearer header never
 * follows a redirect to another host.
 */
export function createFetchLike(
  nativeFetch: (input: string, init: NativeInit) => Promise<Response>,
): FetchLike {
  return (input, init) =>
    nativeFetch(input, {
      headers: new Headers(init.headers),
      credentials: 'omit',
      redirect: 'error',
      ...(init.method === undefined ? {} : { method: init.method }),
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
}
