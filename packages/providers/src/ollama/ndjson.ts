import { ProviderError } from '@local-ai/core';

/** A single Ollama stream line is small; anything longer is a broken or hostile response. */
const maxLineChars = 1_000_000;

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
  let finished = false;
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
      if (buffer.length > maxLineChars) throw new ProviderError('bad_response');
    }
    finished = true;
    const rest = (buffer + decoder.decode()).trim();
    if (rest !== '') yield rest;
  } finally {
    signal.removeEventListener('abort', onAbort);
    // A consumer that stops early (break, return or an error) must close the
    // response too, or Ollama keeps generating into an open socket.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Reads a whole body as text, failing once it exceeds `maxChars`. */
export async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxChars: number,
  signal: AbortSignal,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let text = '';
  let finished = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) throw new ProviderError('bad_response');
    }
    finished = true;
    return text + decoder.decode();
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
