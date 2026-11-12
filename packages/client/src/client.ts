import type { ChatRequestBody, SseEvent } from '@local-ai/contract';
import { sseEventSchema } from '@local-ai/contract';

import { parseSse, SseParseError } from './sse.js';

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
}

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

async function retryAfterMs(res: Response): Promise<number | undefined> {
  const header = res.headers.get('retry-after');
  if (header !== null && /^\d+$/.test(header)) return Number(header) * 1000;
  try {
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const err: unknown = body.error;
      if (
        typeof err === 'object' &&
        err !== null &&
        'retryAfterMs' in err &&
        typeof err.retryAfterMs === 'number'
      ) {
        return err.retryAfterMs;
      }
    }
  } catch {
    // The body is advisory; the status alone decides the error.
  }
  return undefined;
}

export function createChatClient(options: ChatClientOptions): ChatClient {
  const url = `${options.baseUrl}/v1/chat`;
  return {
    async *send(body: ChatRequestBody, signal: AbortSignal): AsyncIterable<SseEvent> {
      let res: Response;
      try {
        res = await options.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(body),
          // Same-origin only until sessions exist (ADR-0009); the dev server proxies the API.
          credentials: 'same-origin',
          signal,
        });
      } catch {
        signal.throwIfAborted();
        throw fail('network', true);
      }

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
        for await (const frame of parseSse(res.body, signal)) {
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
        throw fail('network', true);
      }
      // The stream closed before a done event.
      throw fail('incomplete', true);
    },
  };
}
