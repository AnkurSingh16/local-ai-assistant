import type { AccountClient } from '@local-ai/client';

/** Where the session token lives: the Keychain or Keystore via expo-secure-store on a device. */
export interface TokenStore {
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Holds the bearer token in memory for the clients, which read it synchronously,
 * and keeps it in secure storage between launches (ADR-0009).
 */
export interface Session {
  readonly token: () => string | undefined;
  /** Loads the stored token, checks it with the API, and starts a session if there is none. */
  ensure(
    account: Pick<AccountClient, 'hasSession' | 'startSession'>,
    signal: AbortSignal,
  ): Promise<void>;
  /** Forgets the token after the user deleted everything. */
  forget(): Promise<void>;
}

export function createSession(store: TokenStore): Session {
  let current: string | undefined;
  return {
    token: () => current,
    async ensure(account, signal) {
      current ??= await store.get();
      if (current !== undefined && (await account.hasSession(signal))) return;
      current = undefined;
      const token = await account.startSession(signal);
      current = token;
      await store.set(token);
    },
    async forget() {
      current = undefined;
      await store.clear();
    },
  };
}
