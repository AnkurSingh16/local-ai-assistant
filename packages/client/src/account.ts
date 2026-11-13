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
}

export interface AccountClientOptions {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  /** The bearer token for the Expo app; the web app leaves it out and relies on the cookie. */
  readonly token?: () => string | undefined;
}

const sessionSchema = z.object({ token: z.string().min(20).max(100) });

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
  return {
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
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 401) return false;
      if (!res.ok) throw new AccountError(res.status);
      return true;
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
