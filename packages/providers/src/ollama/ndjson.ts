import { ProviderError } from '@local-ai/core';

/** A single Ollama stream line is small; anything longer is a broken or hostile response. */
const maxLineBytes = 1_000_000;

/** Yields each non-empty line of a newline-delimited stream, decoding UTF-8 across chunk boundaries. */
export async function* readLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let buffer = '';
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== '') yield line;
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > maxLineBytes) throw new ProviderError('bad_response');
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest !== '') yield rest;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
