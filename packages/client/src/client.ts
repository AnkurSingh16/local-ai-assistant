import type { ChatRequestBody, SseEvent } from '@local-ai/contract';
import { sseEventSchema } from '@local-ai/contract';

import { parseSse, SseIdleTimeoutError, SseParseError } from './sse.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ChatClientErrorCode =
  'network' | 'rate_limited' | 'busy' | 'rejected' | 'server' | 'protocol' | 'incomplete';

/** Why a turn could not be delivered. `message` is safe to show to the user. */
export class ChatClientError extends Error {
  constructor(
    readonly code: ChatClientErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ChatClientError';
  }
}

export interface ChatClientOptions {
  /** The API origin, for example http://127.0.0.1:8787, or '' for same-origin. */
  readonly baseUrl: string;
  /** Injected so the web app passes `fetch` and the Expo app passes `expo/fetch`. */
  readonly fetch: FetchLike;
  /** Silence after which the stream counts as lost; defaults to three missed pings. */
  readonly idleTimeoutMs?: number;
  /** Upper bound on waiting for the response headers. */
  readonly connectTimeoutMs?: number;
}

/** Covers reaching the API and getting its headers; the server queues turns only briefly. */
const defaultConnectTimeoutMs = 30_000;

export interface ChatClient {
  /**
   * Sends one message and yields the turn's events, each validated against the
   * shared schema. Aborting the signal cancels the request, which stops the
   * turn on the server. Throws ChatClientError when the turn cannot be
   * delivered; a refusal or a model error arrives as an event, not an exception.
   */
  send(body: ChatRequestBody, signal: AbortSignal): AsyncIterable<SseEvent>;
}

const messages: Readonly<Record<ChatClientErrorCode, string>> = {
  network: "I can't reach the assistant. Check that it is running and try again.",
  rate_limited:
    "You're sending messages faster than I can answer. Please wait a moment and try again.",
  busy: 'The assistant is busy with other messages. Please try again shortly.',
  rejected: 'The assistant did not accept that request.',
  server: 'Something went wrong on the server. Please try again.',
  protocol: 'The assistant sent a response I could not read.',
  incomplete: 'The answer was cut off. Please try again.',
};

function fail(
  code: ChatClientErrorCode,
  retryable: boolean,
  status?: number,
  retryAfterMs?: number,
): ChatClientError {
  return new ChatClientError(code, messages[code], retryable, status, retryAfterMs);
}

/** Upper bound on a server-suggested wait, so a bad value cannot disable retry forever or overflow a timer. */
const maxRetryAfterMs = 10 * 60_000;
/** The error body is advisory, so reading it gets only a short time. */
const errorBodyTimeoutMs = 2000;

function clampRetryAfter(ms: number): number | undefined {
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, maxRetryAfterMs) : undefined;
}

async function retryAfterMs(res: Response): Promise<number | undefined> {
  const header = res.headers.get('retry-after');
  if (header !== null && /^\d+$/.test(header)) {
    await res.body?.cancel().catch(() => undefined);
    return clampRetryAfter(Number(header) * 1000);
  }
  try {
    const body: unknown = await Promise.race([
      res.json(),
      new Promise<undefined>((resolve) => setTimeout(resolve, errorBodyTimeoutMs)),
    ]);
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const err: unknown = body.error;
      if (
        typeof err === 'object' &&
        err !== null &&
        'retryAfterMs' in err &&
        typeof err.retryAfterMs === 'number'
      ) {
        return clampRetryAfter(err.retryAfterMs);
      }
    }
  } catch {
    // The body is advisory; the status alone decides the error.
  }
  await res.body?.cancel().catch(() => undefined);
  return undefined;
}

export function createChatClient(options: ChatClientOptions): ChatClient {
  const url = `${options.baseUrl}/v1/chat`;
  return {
    async *send(body: ChatRequestBody, signal: AbortSignal): AsyncIterable<SseEvent> {
      // One controller for the whole request: the caller's abort always cancels
      // it, and the connect timer cancels it only until the headers arrive. The
      // fetch signal also governs the body, so a plain timeout signal would cut
      // off long answers.
      const request = new AbortController();
      const onAbort = (): void => {
        request.abort(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const connectTimer = setTimeout(() => {
        request.abort();
      }, options.connectTimeoutMs ?? defaultConnectTimeoutMs);

      let res: Response;
      try {
        signal.throwIfAborted();
        res = await options.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(body),
          // Same-origin only until sessions exist (ADR-0009); the dev server proxies the API.
          credentials: 'same-origin',
          signal: request.signal,
        });
      } catch {
        signal.removeEventListener('abort', onAbort);
        signal.throwIfAborted();
        throw fail('network', true);
      } finally {
        clearTimeout(connectTimer);
      }

      try {
        yield* readTurn(res, signal, options.idleTimeoutMs);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

async function* readTurn(
  res: Response,
  signal: AbortSignal,
  idleTimeoutMs: number | undefined,
): AsyncGenerator<SseEvent> {
  if (res.status === 429) throw fail('rate_limited', true, 429, await retryAfterMs(res));
  if (res.status === 503) throw fail('busy', true, 503, await retryAfterMs(res));
  if (res.status >= 500) throw fail('server', true, res.status);
  if (!res.ok) throw fail('rejected', false, res.status);
  if (
    !(res.headers.get('content-type') ?? '').startsWith('text/event-stream') ||
    res.body === null
  ) {
    throw fail('protocol', false, res.status);
  }

  try {
    for await (const frame of parseSse(res.body, signal, idleTimeoutMs)) {
      let json: unknown;
      try {
        json = JSON.parse(frame.data);
      } catch {
        throw fail('protocol', false);
      }
      const parsed = sseEventSchema.safeParse(json);
      if (!parsed.success || parsed.data.type !== frame.event) throw fail('protocol', false);
      yield parsed.data;
      if (parsed.data.type === 'done') return;
    }
  } catch (err) {
    if (err instanceof ChatClientError) throw err;
    signal.throwIfAborted();
    if (err instanceof SseParseError) throw fail('protocol', false);
    if (err instanceof SseIdleTimeoutError) throw fail('incomplete', true);
    throw fail('network', true);
  }
  // The stream closed before a done event.
  throw fail('incomplete', true);
}
