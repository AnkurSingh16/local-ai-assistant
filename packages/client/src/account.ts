import { z } from 'zod';

import type { FetchLike } from './client.js';

/**
 * Session calls shared by the web and Expo apps (ADR-0009). The web app relies
 * on the HttpOnly cookie the API sets and never sees the token's use; the Expo
 * app keeps the returned token in secure storage and sends it as a bearer token.
 */
export interface AccountClient {
  /** Starts an anonymous session and returns its token. */
  startSession(signal: AbortSignal): Promise<string>;
  /** True when the session cookie or bearer token still names an active session. */
  hasSession(signal: AbortSignal): Promise<boolean>;
  /** Everything remembered about this session. */
  memory(signal: AbortSignal): Promise<MemoryEntry[]>;
  /** Forgets one remembered item. */
  forget(id: string, signal: AbortSignal): Promise<void>;
  /** Deletes the session and everything stored under it. */
  deleteEverything(signal: AbortSignal): Promise<void>;
  /** Sends feedback, a correction or a preference for review. */
  sendFeedback(kind: FeedbackKind, text: string, signal: AbortSignal): Promise<void>;
}

export interface MemoryEntry {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
}

export type FeedbackKind = 'feedback' | 'correction' | 'preference';

const memorySchema = z.object({
  items: z.array(z.object({ id: z.string(), content: z.string(), createdAt: z.string() })),
});

export interface AccountClientOptions {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  /** The bearer token for the Expo app; the web app leaves it out and relies on the cookie. */
  readonly token?: () => string | undefined;
}

const sessionSchema = z.object({ token: z.string().min(20).max(100) });
const meSchema = z.object({ active: z.boolean() });

export class AccountError extends Error {
  constructor(readonly status: number | undefined) {
    super(status === undefined ? 'The assistant could not be reached.' : 'The request failed.');
    this.name = 'AccountError';
  }
}

export function createAccountClient(options: AccountClientOptions): AccountClient {
  const headers = (): Record<string, string> => {
    const token = options.token?.();
    return token === undefined ? {} : { authorization: `Bearer ${token}` };
  };
  const call = async (path: string, init: RequestInit, signal: AbortSignal): Promise<Response> => {
    let res: Response;
    try {
      res = await options.fetch(`${options.baseUrl}${path}`, {
        ...init,
        credentials: 'same-origin',
        headers: {
          ...headers(),
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new AccountError(undefined);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new AccountError(res.status);
    }
    return res;
  };
  return {
    async memory(signal) {
      const res = await call('/v1/me/memory', { method: 'GET' }, signal);
      const parsed = memorySchema.safeParse(await res.json());
      if (!parsed.success) throw new AccountError(res.status);
      return parsed.data.items;
    },
    async forget(id, signal) {
      const res = await call(
        `/v1/me/memory/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
        signal,
      );
      await res.body?.cancel().catch(() => undefined);
    },
    async deleteEverything(signal) {
      const res = await call('/v1/me', { method: 'DELETE' }, signal);
      await res.body?.cancel().catch(() => undefined);
    },
    async sendFeedback(kind, text, signal) {
      const res = await call(
        '/v1/feedback',
        { method: 'POST', body: JSON.stringify({ kind, text }) },
        signal,
      );
      await res.body?.cancel().catch(() => undefined);
    },
    async hasSession(signal) {
      let res: Response;
      try {
        res = await options.fetch(`${options.baseUrl}/v1/me`, {
          method: 'GET',
          credentials: 'same-origin',
          headers: headers(),
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        throw new AccountError(undefined);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new AccountError(res.status);
      }
      const parsed = meSchema.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new AccountError(res.status);
      return parsed.data.active;
    },
    async startSession(signal) {
      let res: Response;
      try {
        res = await options.fetch(`${options.baseUrl}/v1/sessions`, {
          method: 'POST',
          credentials: 'same-origin',
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        throw new AccountError(undefined);
      }
      if (!res.ok) throw new AccountError(res.status);
      const parsed = sessionSchema.safeParse(await res.json());
      if (!parsed.success) throw new AccountError(res.status);
      return parsed.data.token;
    },
  };
}
