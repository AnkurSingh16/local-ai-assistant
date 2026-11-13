import { createHash, randomBytes } from 'node:crypto';

import type { ConversationRepo, MemoryRepo, SessionRepo } from '@local-ai/storage';

/**
 * Sessions without accounts (ADR-0009). The token is 256 random bits; only its
 * SHA-256 hash is stored, so a copy of the database cannot be used to act as
 * anyone. Routes see this service, never the repositories (ADR-0002).
 */
export interface SessionService {
  /** Creates a session and returns its token, which is shown to the client once. */
  create(): Promise<string>;
  /** The session id for a token, if the session exists and is in use. */
  resolve(token: string): Promise<string | undefined>;
  /** True when the conversation is new or already belongs to this session. */
  claimConversation(conversationId: string, sessionId: string): Promise<boolean>;
  /** Everything remembered about the session (ADR-0009). */
  memory(
    sessionId: string,
  ): Promise<{ id: string; content: string; createdAt: Date; always: boolean }[]>;
  /** Forgets one remembered item; false if it does not belong to this session. */
  forget(sessionId: string, memoryId: string): Promise<boolean>;
  /** Deletes the session and everything stored under it, for real. */
  deleteEverything(sessionId: string): Promise<void>;
}

export const sessionCookie = 'lai_session';

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

export function createSessionService(deps: {
  readonly sessions: SessionRepo;
  readonly conversations: ConversationRepo;
  readonly memory: MemoryRepo;
  readonly randomToken?: () => string;
}): SessionService {
  const randomToken = deps.randomToken ?? (() => randomBytes(32).toString('base64url'));
  return {
    async create() {
      const token = randomToken();
      await deps.sessions.create(hash(token));
      return token;
    },
    async resolve(token) {
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return undefined;
      const id = await deps.sessions.findActive(hash(token));
      if (id !== undefined) await deps.sessions.touch(id);
      return id;
    },
    claimConversation(conversationId, sessionId) {
      return deps.conversations.claim(conversationId, sessionId);
    },
    memory: (sessionId) => deps.memory.list(sessionId),
    forget: (sessionId, memoryId) => deps.memory.delete(sessionId, memoryId),
    deleteEverything: (sessionId) => deps.sessions.delete(sessionId),
  };
}

/** The token from the session cookie (web) or an Authorization bearer header (mobile). */
export function tokenFrom(
  cookies: Readonly<Record<string, string | undefined>>,
  authorization: string | undefined,
): string | undefined {
  const bearer = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(authorization ?? '');
  return bearer?.[1] ?? cookies[sessionCookie];
}
