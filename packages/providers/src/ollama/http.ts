import { ProviderError } from '@local-ai/core';

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** POSTs JSON to Ollama, mapping network and HTTP failures to ProviderError without the vendor text. */
export async function postJson(
  fetchFn: FetchFn,
  url: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    signal.throwIfAborted();
    throw new ProviderError('unavailable', undefined, { cause: err });
  }
  if (!res.ok) {
    // Drain so the connection can be reused; the body is not surfaced anywhere.
    await res.body?.cancel().catch(() => undefined);
    throw new ProviderError(res.status === 404 ? 'model_missing' : 'unavailable', res.status);
  }
  return res;
}

export function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (err) {
    throw new ProviderError('bad_response', undefined, { cause: err });
  }
}
