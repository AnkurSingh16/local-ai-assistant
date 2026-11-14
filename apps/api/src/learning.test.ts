import { createManualClock } from '@local-ai/core';
import { createInputGuard } from '@local-ai/guardrails';
import {
  createMockEmbeddingProvider,
  createMockModerationProvider,
} from '@local-ai/providers/mock';
import {
  createFlagLog,
  createMemoryRepo,
  createReviewRepo,
  createSessionRepo,
  openDatabase,
} from '@local-ai/storage';
import { describe, expect, it } from 'vitest';

import {
  approvalMessage,
  maxAlwaysTokens,
  parseApproveArgs,
  createFeedbackService,
  createMemoryRecall,
  createReviewer,
  paraphraseProblem,
} from './learning.js';

function setup() {
  const db = openDatabase(':memory:');
  let n = 0;
  const deps = {
    db,
    clock: createManualClock(new Date('2026-11-13T00:00:00Z')),
    newId: () => `id-${String(++n)}`,
  };
  const inputGuard = createInputGuard({
    moderation: createMockModerationProvider(),
    timeoutMs: 1000,
  });
  const review = createReviewRepo(deps);
  const memory = createMemoryRepo(deps);
  const embeddings = createMockEmbeddingProvider();
  return {
    db,
    deps,
    inputGuard,
    review,
    memory,
    embeddings,
    sessions: createSessionRepo(deps),
    flags: createFlagLog(deps),
  };
}

const signal = new AbortController().signal;

describe('feedback', () => {
  it('queues moderated feedback and drops flagged feedback, keeping only its category', async () => {
    const s = setup();
    const session = await s.sessions.create('h');
    const feedback = createFeedbackService({
      inputGuard: s.inputGuard,
      review: s.review,
      flags: s.flags,
    });
    expect(await feedback.submit(session, 'preference', 'I prefer metric units.', signal)).toBe(
      'queued',
    );
    expect(await feedback.submit(session, 'feedback', 'MOCK_FLAG you are awful', signal)).toBe(
      'dropped',
    );
    expect((await s.review.pending()).map((r) => r.content)).toEqual(['I prefer metric units.']);
    const rows = s.db.prepare('SELECT category FROM flagged_events').all();
    expect(rows).toEqual([{ category: 'policy' }]);
    expect(JSON.stringify(s.db.prepare('SELECT * FROM review_items').all())).not.toContain(
      'MOCK_FLAG',
    );
  });
});

describe('feedback limits', () => {
  it('drops feedback once a session has 20 items waiting', async () => {
    const s = setup();
    const session = await s.sessions.create('h');
    const feedback = createFeedbackService({
      inputGuard: s.inputGuard,
      review: s.review,
      flags: s.flags,
    });
    for (let i = 0; i < 20; i++) {
      expect(await feedback.submit(session, 'feedback', `Note ${String(i)}`, signal)).toBe(
        'queued',
      );
    }
    expect(await feedback.submit(session, 'feedback', 'One more', signal)).toBe('dropped');
    expect(await s.review.pendingCount(session)).toBe(20);
  });
});

describe('review', () => {
  it('turns an approved preference into memory with an embedding, and only marks feedback', async () => {
    const s = setup();
    const session = await s.sessions.create('h');
    const pref = await s.review.add(session, 'preference', await mint(s, 'Call me Sam.'));
    const note = await s.review.add(session, 'feedback', await mint(s, 'Great answer.'));
    const reviewer = createReviewer({
      review: s.review,
      memory: s.memory,
      embeddings: s.embeddings,
      inputGuard: s.inputGuard,
    });
    expect(await reviewer.approve(pref, signal)).toBe('approved');
    expect(await reviewer.approve(note, signal)).toBe('approved');
    expect((await s.memory.list(session)).map((m) => m.content)).toEqual(['Call me Sam.']);
    expect(await s.memory.withEmbeddings(session)).toHaveLength(1);
    expect(await reviewer.pending()).toEqual([]);
    expect(await reviewer.approve('missing', signal)).toBe('not_found');
  });

  it('rejects without creating memory', async () => {
    const s = setup();
    const session = await s.sessions.create('h');
    const id = await s.review.add(session, 'correction', await mint(s, 'The capital is Canberra.'));
    const reviewer = createReviewer({
      review: s.review,
      memory: s.memory,
      embeddings: s.embeddings,
      inputGuard: s.inputGuard,
    });
    expect(await reviewer.reject(id)).toBe(true);
    expect(await s.memory.list(session)).toEqual([]);
  });
});

describe('review decisions happen once, and moved text is not kept', () => {
  function reviewerFor(s: ReturnType<typeof setup>) {
    return createReviewer({
      review: s.review,
      memory: s.memory,
      embeddings: s.embeddings,
      inputGuard: s.inputGuard,
    });
  }

  it('does not re-create memory the user deleted when an item is approved again', async () => {
    const s = setup();
    const session = await s.sessions.create('h');
    const id = await s.review.add(
      session,
      'preference',
      await mint(s, 'Please call me Sam from Leeds.'),
    );
    const reviewer = reviewerFor(s);
    expect(await reviewer.approve(id, signal)).toBe('approved');
    const [item] = await s.memory.list(session);
    expect(await s.memory.delete(session, item?.id ?? '')).toBe(true);
    expect(await reviewer.approve(id, signal)).toBe('not_found');
    expect(await s.memory.list(session)).toEqual([]);
  });

  it('never turns a rejected item into memory', async () => {
    const s = setup();
    const session = await s.sessions.create('h');
    const id = await s.review.add(session, 'preference', await mint(s, 'Call me Sam.'));
    const reviewer = reviewerFor(s);
    expect(await reviewer.reject(id)).toBe(true);
    expect(await reviewer.approve(id, signal)).toBe('not_found');
    expect(await s.memory.list(session)).toEqual([]);
  });

  it('keeps no copy of the text once it moved to memory and the user forgot it', async () => {
    const s = setup();
    const session = await s.sessions.create('h');
    const id = await s.review.add(
      session,
      'preference',
      await mint(s, 'Please call me Sam from Leeds.'),
    );
    expect(await reviewerFor(s).approve(id, signal)).toBe('approved');
    const [item] = await s.memory.list(session);
    await s.memory.delete(session, item?.id ?? '');
    const everything = JSON.stringify([
      s.db.prepare('SELECT * FROM review_items').all(),
      s.db.prepare('SELECT * FROM memory').all(),
    ]);
    expect(everything).not.toContain('Leeds');
  });
});

describe('memory recall', () => {
  it('returns approved items similar to the message, for that session only', async () => {
    const s = setup();
    const a = await s.sessions.create('a');
    const b = await s.sessions.create('b');
    const text = 'Call me Sam.';
    const [vector] = await s.embeddings.embed([text], signal);
    await s.memory.add(a, await mint(s, text), vector);
    const recall = createMemoryRecall({
      memory: s.memory,
      embeddings: s.embeddings,
      timeoutMs: 1000,
    });
    expect(await recall.recall(a, text, signal)).toEqual([text]);
    expect(await recall.recall(a, 'Something unrelated entirely.', signal)).toEqual([]);
    expect(await recall.recall(b, text, signal)).toEqual([]);
  });

  it('gives no memory, not an error, when embedding fails', async () => {
    const s = setup();
    const a = await s.sessions.create('a');
    await s.memory.add(a, await mint(s, 'x y z'), new Float32Array([1, 0]));
    const recall = createMemoryRecall({
      memory: s.memory,
      embeddings: { model: 'm', dimensions: 2, embed: () => Promise.reject(new Error('down')) },
      timeoutMs: 1000,
    });
    expect(await recall.recall(a, 'x y z', signal)).toEqual([]);
  });
});

describe('always-on memory', () => {
  it('approves an item as always-on without an embedding, and recalls it for every message', async () => {
    const s = setup();
    const a = await s.sessions.create('a');
    const id = await s.review.add(a, 'preference', await mint(s, "I'm allergic to peanuts."));
    let embedCalls = 0;
    const counting = {
      ...s.embeddings,
      embed: (texts: readonly string[], sig: AbortSignal) => {
        embedCalls += 1;
        return s.embeddings.embed(texts, sig);
      },
    };
    const reviewer = createReviewer({
      review: s.review,
      memory: s.memory,
      embeddings: counting,
      inputGuard: s.inputGuard,
    });
    expect(await reviewer.approve(id, signal, { always: true })).toBe('approved');
    expect(embedCalls).toBe(0);
    expect((await s.memory.list(a)).map((m) => m.always)).toEqual([true]);
    const recall = createMemoryRecall({ memory: s.memory, embeddings: counting, timeoutMs: 1000 });
    expect(await recall.recall(a, 'What should I make for dinner?', signal)).toEqual([
      "I'm allergic to peanuts.",
    ]);
  });

  it('still recalls always-on items when the embedding model is down, ahead of similar ones', async () => {
    const s = setup();
    const a = await s.sessions.create('a');
    await s.memory.add(a, await mint(s, 'I am vegetarian.'), undefined, true);
    await s.memory.add(a, await mint(s, 'x y z'), new Float32Array([1, 0]));
    const down = createMemoryRecall({
      memory: s.memory,
      embeddings: { model: 'm', dimensions: 2, embed: () => Promise.reject(new Error('down')) },
      timeoutMs: 1000,
    });
    expect(await down.recall(a, 'x y z', signal)).toEqual(['I am vegetarian.']);
    // Always-on items are not scored by similarity, so they are never listed twice.
    expect(await s.memory.withEmbeddings(a)).toHaveLength(1);
  });
});

describe('promoting an eval case', () => {
  it('refuses a paraphrase that copies the user or carries personal data', () => {
    const source = 'my landlord at 12 Rose Street keeps the deposit and will not answer';
    expect(
      paraphraseProblem(source, 'A tenant cannot get money back from a silent landlord'),
    ).toBeUndefined();
    expect(paraphraseProblem(source, 'he keeps the deposit and will not answer')).toContain('five');
    expect(paraphraseProblem(source, 'write to sam@example.com about it')).toContain('email');
    expect(paraphraseProblem(source, 'call 020 7946 0958 today')).toContain('digits');
    expect(paraphraseProblem(source, 'call 555.123.4567 today')).toContain('digits');
    expect(paraphraseProblem(source, 'call (555) 123-4567 today')).toContain('digits');
    expect(paraphraseProblem(source, 'see https://x.example/a?id=4 now')).toContain('query');
  });
});

async function mint(s: ReturnType<typeof setup>, text: string) {
  const verdict = await s.inputGuard.check(text, signal);
  if (!verdict.ok) throw new Error('refused');
  return verdict.text;
}

describe('always-on memory limits', () => {
  function reviewerFor(s: ReturnType<typeof setup>) {
    return createReviewer({
      review: s.review,
      memory: s.memory,
      embeddings: s.embeddings,
      inputGuard: s.inputGuard,
    });
  }

  it('refuses an always-on approval that would take more than half the memory slot', async () => {
    const s = setup();
    const a = await s.sessions.create('a');
    const long = await s.review.add(a, 'preference', await mint(s, 'long '.repeat(190)));
    expect(await reviewerFor(s).approve(long, signal, { always: true })).toBe('always_full');
    expect(await s.memory.list(a)).toEqual([]);
    // Still approvable as an ordinary item.
    expect(await reviewerFor(s).approve(long, signal)).toBe('approved');
  });

  it('puts always-on items before similar ones, each once, and forgetting one removes it', async () => {
    const s = setup();
    const a = await s.sessions.create('a');
    const text = 'Call me Sam.';
    const [vector] = await s.embeddings.embed([text], signal);
    await s.memory.add(a, await mint(s, text), vector);
    const allergyId = await s.memory.add(
      a,
      await mint(s, "I'm allergic to peanuts."),
      undefined,
      true,
    );
    const recall = createMemoryRecall({
      memory: s.memory,
      embeddings: s.embeddings,
      timeoutMs: 1000,
    });
    expect(await recall.recall(a, text, signal)).toEqual(["I'm allergic to peanuts.", text]);
    await s.memory.delete(a, allergyId);
    expect(await recall.recall(a, text, signal)).toEqual([text]);
  });
});

describe('review command arguments', () => {
  it('reads an id and --always, and refuses typos or a missing id', () => {
    expect(parseApproveArgs(['id-1'])).toEqual({ id: 'id-1', always: false });
    expect(parseApproveArgs(['id-1', '--always'])).toEqual({ id: 'id-1', always: true });
    expect(parseApproveArgs(['id-1', '--alway'])).toEqual({
      error: 'Unknown option --alway; only --always.',
    });
    expect(parseApproveArgs(['--always', 'id-1'])).toEqual({ error: 'approve needs an id first.' });
    expect(parseApproveArgs([])).toEqual({ error: 'approve needs an id first.' });
  });

  it('confirms an always-on approval and explains a refusal', () => {
    expect(approvalMessage('approved', true)).toBe('approved (always: used in every answer)');
    expect(approvalMessage('approved', false)).toBe('approved');
    expect(approvalMessage('always_full', true)).toContain(`${String(maxAlwaysTokens)} tokens`);
    expect(approvalMessage('not_found', true)).toBe('not_found');
  });
});
