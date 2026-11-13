import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModeratedText } from '@local-ai/core';
import { createManualClock } from '@local-ai/core';
import { createInputGuard } from '@local-ai/guardrails';
import { createMockModerationProvider } from '@local-ai/providers/mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from './db.js';
import { openDatabase } from './db.js';
import {
  createConversationRepo,
  createFlagLog,
  createMemoryRepo,
  createReviewRepo,
  createSessionRepo,
  sessionIdleMs,
} from './repos.js';

/** Storage accepts only moderated text, so tests mint it the only way there is: through the guard. */
const guard = createInputGuard({ moderation: createMockModerationProvider(), timeoutMs: 1000 });
async function moderated(text: string): Promise<ModeratedText> {
  const verdict = await guard.check(text, new AbortController().signal);
  if (!verdict.ok) throw new Error('test text was refused');
  return verdict.text;
}

let dir: string;
let path: string;
let db: Database;
const clock = createManualClock(new Date('2026-11-13T00:00:00Z'));
let n = 0;
const deps = () => ({ db, clock, newId: () => `id-${String(++n)}` });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lai-storage-'));
  path = join(dir, 'test.db');
  db = openDatabase(path);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Everything on disk for this database: the main file and the WAL. */
function onDisk(): string {
  let bytes = readFileSync(path).toString('latin1');
  try {
    bytes += readFileSync(`${path}-wal`).toString('latin1');
  } catch {
    // No WAL file means nothing is waiting in it.
  }
  return bytes;
}

describe('database', () => {
  it('turns on foreign keys, WAL and secure delete, and migrates once', () => {
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA secure_delete').get()).toEqual({ secure_delete: 1 });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    db.close();
    db = openDatabase(path);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
  });
});

describe('sessions', () => {
  it('finds a session by token hash only while it is in use', async () => {
    const sessions = createSessionRepo(deps());
    const id = await sessions.create('hash-a');
    expect(await sessions.findActive('hash-a')).toBe(id);
    expect(await sessions.findActive('hash-b')).toBeUndefined();
    clock.advance(sessionIdleMs);
    expect(await sessions.findActive('hash-a')).toBeUndefined();
    expect(await sessions.purgeIdle()).toBe(1);
  });
});

describe('conversations', () => {
  it('keeps a conversation to the session that started it and returns recent messages in order', async () => {
    const sessions = createSessionRepo(deps());
    const conversations = createConversationRepo(deps());
    const a = await sessions.create('a');
    const b = await sessions.create('b');
    expect(await conversations.claim('c1', a)).toBe(true);
    expect(await conversations.claim('c1', b)).toBe(false);
    for (const t of ['one', 'two', 'three']) {
      await conversations.append('c1', 'user', [await moderated(t)]);
    }
    expect(await conversations.recent('c1', 2)).toEqual([
      { role: 'user', content: 'two' },
      { role: 'user', content: 'three' },
    ]);
  });
});

describe('memory and review', () => {
  it('stores embeddings and deletes only within the owning session', async () => {
    const sessions = createSessionRepo(deps());
    const memory = createMemoryRepo(deps());
    const a = await sessions.create('a');
    const b = await sessions.create('b');
    const id = await memory.add(
      a,
      await moderated('Prefers metric units'),
      new Float32Array([1, 0, 0.5]),
    );
    expect((await memory.list(a)).map((m) => m.content)).toEqual(['Prefers metric units']);
    expect((await memory.withEmbeddings(a))[0]?.embedding).toEqual(new Float32Array([1, 0, 0.5]));
    expect(await memory.delete(b, id)).toBe(false);
    expect(await memory.delete(a, id)).toBe(true);
    expect(await memory.list(a)).toEqual([]);
  });

  it('queues items for review and decides each once', async () => {
    const sessions = createSessionRepo(deps());
    const review = createReviewRepo(deps());
    const a = await sessions.create('a');
    const id = await review.add(a, 'preference', await moderated('Call me Sam'));
    expect((await review.pending()).map((r) => r.kind)).toEqual(['preference']);
    expect(await review.decide(id, 'approved')).toBe(true);
    expect(await review.decide(id, 'rejected')).toBe(false);
    expect(await review.pending()).toEqual([]);
  });
});

describe('deletion is real', () => {
  it('deleting a session removes everything under it, from the tables and from the files', async () => {
    const marker = 'ZQXMARKER-unique-text';
    const sessions = createSessionRepo(deps());
    const conversations = createConversationRepo(deps());
    const memory = createMemoryRepo(deps());
    const review = createReviewRepo(deps());
    const flags = createFlagLog(deps());
    const id = await sessions.create('hash');
    await conversations.claim('c1', id);
    await conversations.append('c1', 'user', [await moderated(`${marker} in a message`)]);
    await memory.add(id, await moderated(`${marker} in memory`), undefined);
    await review.add(id, 'feedback', await moderated(`${marker} in feedback`));
    await flags.record(id, 'policy');
    expect(onDisk()).toContain(marker);

    await sessions.delete(id);

    for (const table of [
      'sessions',
      'conversations',
      'messages',
      'memory',
      'review_items',
      'flagged_events',
    ]) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    expect(onDisk()).not.toContain(marker);
  });

  it('deleting one memory item removes it from the files too', async () => {
    const marker = 'ZQXMEMORY-only-here';
    const sessions = createSessionRepo(deps());
    const memory = createMemoryRepo(deps());
    const id = await sessions.create('hash');
    const item = await memory.add(id, await moderated(marker), undefined);
    expect(onDisk()).toContain(marker);
    await memory.delete(id, item);
    expect(onDisk()).not.toContain(marker);
  });
});
