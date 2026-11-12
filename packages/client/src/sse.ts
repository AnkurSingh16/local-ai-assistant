/** One parsed Server-Sent Events frame. */
export interface SseFrame {
  readonly event: string;
  readonly id: string | undefined;
  readonly data: string;
}

/** Bounds what a broken or hostile server can make the client buffer. */
export const maxFrameChars = 1_000_000;

export class SseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseParseError';
  }
}

/**
 * Parses an SSE byte stream per the WHATWG format: LF, CR or CRLF line ends,
 * `field: value` lines, multi-line `data`, comment lines starting with `:`, and
 * a blank line ending each frame. Works on any `ReadableStream`, so the same
 * parser runs on `fetch` in browsers and `expo/fetch` on mobile, where there is
 * no EventSource.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  let buffer = '';
  let event = '';
  let id: string | undefined;
  let data: string[] = [];
  let dataChars = 0;
  let finished = false;

  const take = (line: string): SseFrame | undefined => {
    if (line === '') {
      const frame =
        data.length > 0 ? { event: event || 'message', id, data: data.join('\n') } : undefined;
      event = '';
      data = [];
      dataChars = 0;
      return frame;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') {
      dataChars += value.length;
      if (dataChars > maxFrameChars) throw new SseParseError('frame too large');
      data.push(value);
    } else if (field === 'id' && !value.includes('\0')) id = value;
    return undefined;
  };

  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (match === null) break;
        // A lone CR at the very end may be the first half of a CRLF split across chunks.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = take(line);
        if (frame !== undefined) yield frame;
      }
      if (buffer.length > maxFrameChars) throw new SseParseError('line too long');
    }
    finished = true;
    buffer += decoder.decode();
    // A trailing frame without its blank line is incomplete and is dropped, as the spec says.
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
