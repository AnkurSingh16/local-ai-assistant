import type { Clock, ModeratedText } from '@local-ai/core';

import type { Database } from './db.js';
import { checkpoint } from './db.js';

/**
 * Repositories over the database (ADR-0001). Everything a user wrote is stored
 * only as ModeratedText, which only the guards can mint, so flagged text can
 * never reach a table (ADR-0002). Methods are async so a hosted database could
 * replace SQLite without changing callers.
 */

export interface StoredMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface MemoryItem {
  readonly id: string;
  readonly content: string;
  readonly createdAt: Date;
}

export type ReviewKind = 'feedback' | 'correction' | 'preference';

export interface ReviewItem {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: ReviewKind;
  readonly content: string;
  readonly createdAt: Date;
}

export interface StorageDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly newId: () => string;
}

/** Sessions expire after 30 days without use (ADR-0009). */
export const sessionIdleMs = 30 * 24 * 60 * 60 * 1000;

export interface SessionRepo {
  /** Stores only the token's hash; the token itself is never written. */
  create(tokenHash: string): Promise<string>;
  /** The session for a token hash, if it exists and has been used in the last 30 days. */
  findActive(tokenHash: string): Promise<string | undefined>;
  touch(sessionId: string): Promise<void>;
  /** Deletes the session and, by cascade, everything stored under it. */
  delete(sessionId: string): Promise<void>;
  /** Deletes idle sessions, returning how many went. */
  purgeIdle(): Promise<number>;
}

export interface ConversationRepo {
  /** True when the conversation exists and belongs to this session, creating it if new. */
  claim(conversationId: string, sessionId: string): Promise<boolean>;
  /** Stores one message; an answer released paragraph by paragraph is stored as one message. */
  append(
    conversationId: string,
    role: 'user' | 'assistant',
    parts: readonly ModeratedText[],
  ): Promise<void>;
  /** The most recent messages, oldest first. */
  recent(conversationId: string, limit: number): Promise<StoredMessage[]>;
}

export interface MemoryRepo {
  add(
    sessionId: string,
    content: ModeratedText,
    embedding: Float32Array | undefined,
  ): Promise<string>;
  list(sessionId: string): Promise<MemoryItem[]>;
  /** Memory with embeddings, for similarity search. */
  withEmbeddings(sessionId: string): Promise<{ content: string; embedding: Float32Array }[]>;
  /** True if an item was deleted; an id from another session deletes nothing. */
  delete(sessionId: string, id: string): Promise<boolean>;
}

export interface ReviewRepo {
  add(sessionId: string, kind: ReviewKind, content: ModeratedText): Promise<string>;
  pending(): Promise<ReviewItem[]>;
  get(id: string): Promise<ReviewItem | undefined>;
  decide(id: string, status: 'approved' | 'rejected'): Promise<boolean>;
}

export interface FlagLog {
  /** Records that something was flagged: the category and the time, never the text. */
  record(sessionId: string | undefined, category: string): Promise<void>;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export function createSessionRepo({ db, clock, newId }: StorageDeps): SessionRepo {
  return {
    create(tokenHash) {
      const id = newId();
      const now = clock.now().getTime();
      db.prepare(
        'INSERT INTO sessions (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
      ).run(id, tokenHash, now, now);
      return Promise.resolve(id);
    },
    findActive(tokenHash) {
      const row = db
        .prepare('SELECT id FROM sessions WHERE token_hash = ? AND last_seen_at > ?')
        .get(tokenHash, clock.now().getTime() - sessionIdleMs);
      return Promise.resolve(row === undefined ? undefined : text(row.id));
    },
    touch(sessionId) {
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(
        clock.now().getTime(),
        sessionId,
      );
      return Promise.resolve();
    },
    delete(sessionId) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      checkpoint(db);
      return Promise.resolve();
    },
    purgeIdle() {
      const result = db
        .prepare('DELETE FROM sessions WHERE last_seen_at <= ?')
        .run(clock.now().getTime() - sessionIdleMs);
      checkpoint(db);
      return Promise.resolve(Number(result.changes));
    },
  };
}

export function createConversationRepo({ db, clock }: StorageDeps): ConversationRepo {
  return {
    claim(conversationId, sessionId) {
      const row = db
        .prepare('SELECT session_id FROM conversations WHERE id = ?')
        .get(conversationId);
      if (row !== undefined) return Promise.resolve(text(row.session_id) === sessionId);
      db.prepare('INSERT INTO conversations (id, session_id, created_at) VALUES (?, ?, ?)').run(
        conversationId,
        sessionId,
        clock.now().getTime(),
      );
      return Promise.resolve(true);
    },
    append(conversationId, role, parts) {
      const content = parts.join('');
      db.prepare(
        'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)',
      ).run(conversationId, role, content, clock.now().getTime());
      return Promise.resolve();
    },
    recent(conversationId, limit) {
      const rows = db
        .prepare(
          'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(conversationId, limit);
      return Promise.resolve(
        rows
          .map((r) => ({
            role: text(r.role) === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: text(r.content),
          }))
          .reverse(),
      );
    },
  };
}

const toBlob = (v: Float32Array): Uint8Array =>
  new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (v: unknown): Float32Array | undefined => {
  if (!(v instanceof Uint8Array) || v.byteLength % 4 !== 0) return undefined;
  const copy = new Uint8Array(v);
  return new Float32Array(copy.buffer);
};

export function createMemoryRepo({ db, clock, newId }: StorageDeps): MemoryRepo {
  return {
    add(sessionId, content, embedding) {
      const id = newId();
      db.prepare(
        'INSERT INTO memory (id, session_id, content, embedding, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(
        id,
        sessionId,
        content,
        embedding === undefined ? null : toBlob(embedding),
        clock.now().getTime(),
      );
      return Promise.resolve(id);
    },
    list(sessionId) {
      const rows = db
        .prepare(
          'SELECT id, content, created_at FROM memory WHERE session_id = ? ORDER BY created_at, id',
        )
        .all(sessionId);
      return Promise.resolve(
        rows.map((r) => ({
          id: text(r.id),
          content: text(r.content),
          createdAt: new Date(num(r.created_at)),
        })),
      );
    },
    withEmbeddings(sessionId) {
      const rows = db
        .prepare(
          'SELECT content, embedding FROM memory WHERE session_id = ? AND embedding IS NOT NULL',
        )
        .all(sessionId);
      const out: { content: string; embedding: Float32Array }[] = [];
      for (const r of rows) {
        const embedding = fromBlob(r.embedding);
        if (embedding !== undefined) out.push({ content: text(r.content), embedding });
      }
      return Promise.resolve(out);
    },
    delete(sessionId, id) {
      const result = db
        .prepare('DELETE FROM memory WHERE id = ? AND session_id = ?')
        .run(id, sessionId);
      checkpoint(db);
      return Promise.resolve(Number(result.changes) > 0);
    },
  };
}

const kinds: readonly ReviewKind[] = ['feedback', 'correction', 'preference'];
const asKind = (v: unknown): ReviewKind => kinds.find((k) => k === v) ?? 'feedback';

export function createReviewRepo({ db, clock, newId }: StorageDeps): ReviewRepo {
  const toItem = (r: Record<string, unknown>): ReviewItem => ({
    id: text(r.id),
    sessionId: text(r.session_id),
    kind: asKind(r.kind),
    content: text(r.content),
    createdAt: new Date(num(r.created_at)),
  });
  return {
    add(sessionId, kind, content) {
      const id = newId();
      db.prepare(
        'INSERT INTO review_items (id, session_id, kind, content, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, sessionId, kind, content, clock.now().getTime());
      return Promise.resolve(id);
    },
    pending() {
      const rows = db
        .prepare(
          "SELECT id, session_id, kind, content, created_at FROM review_items WHERE status = 'pending' ORDER BY created_at, id",
        )
        .all();
      return Promise.resolve(rows.map(toItem));
    },
    get(id) {
      const row = db
        .prepare('SELECT id, session_id, kind, content, created_at FROM review_items WHERE id = ?')
        .get(id);
      return Promise.resolve(row === undefined ? undefined : toItem(row));
    },
    decide(id, status) {
      const result = db
        .prepare("UPDATE review_items SET status = ? WHERE id = ? AND status = 'pending'")
        .run(status, id);
      return Promise.resolve(Number(result.changes) > 0);
    },
  };
}

export function createFlagLog({ db, clock }: StorageDeps): FlagLog {
  return {
    record(sessionId, category) {
      db.prepare(
        'INSERT INTO flagged_events (session_id, category, created_at) VALUES (?, ?, ?)',
      ).run(sessionId ?? null, category.slice(0, 40), clock.now().getTime());
      return Promise.resolve();
    },
  };
}
