/** One parsed Server-Sent Events frame. */
export interface SseFrame {
  readonly event: string;
  readonly id: string | undefined;
  readonly data: string;
}

/** Bounds what a broken or hostile server can make the client buffer. */
/** Measured in UTF-16 characters, as decoded. */
export const maxFrameChars = 1_000_000;

export class SseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseParseError';
  }
}

/**
 * How long the stream may stay silent. The server sends a `: ping` every 15 s
 * (ADR-0007), so three missed pings mean the connection is gone, which a
 * half-open socket on a dropped Wi-Fi link would otherwise hide forever.
 */
export const defaultIdleTimeoutMs = 45_000;

export class SseIdleTimeoutError extends Error {
  constructor() {
    super('stream idle too long');
    this.name = 'SseIdleTimeoutError';
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
  idleTimeoutMs: number = defaultIdleTimeoutMs,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  // An object, so the compiler sees the timer callback's write.
  const idle = { fired: false };
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idle.fired = true;
      void reader.cancel().catch(() => undefined);
    }, idleTimeoutMs);
  };
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
      armIdleTimer();
      const { done, value } = await reader.read();
      // Only the wait for data counts as idle, not time the consumer spends.
      clearTimeout(idleTimer);
      signal.throwIfAborted();
      if (idle.fired) throw new SseIdleTimeoutError();
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
    // At the end a lone CR is a complete line end too. Lines still without one,
    // and a frame without its blank line, are incomplete and dropped (WHATWG).
    for (let m = /\r\n|\r|\n/.exec(buffer); m !== null; m = /\r\n|\r|\n/.exec(buffer)) {
      const frame = take(buffer.slice(0, m.index));
      buffer = buffer.slice(m.index + m[0].length);
      if (frame !== undefined) yield frame;
    }
  } finally {
    clearTimeout(idleTimer);
    signal.removeEventListener('abort', onAbort);
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
