import type { MemoryRecall } from '@local-ai/agent';
import { contextBudget, estimateTokens } from '@local-ai/agent';
import type { EmbeddingProvider } from '@local-ai/core';
import { cosineSimilarity } from '@local-ai/core';
import type { InputGuard } from '@local-ai/guardrails';
import type { FlagLog, MemoryRepo, ReviewItem, ReviewKind, ReviewRepo } from '@local-ai/storage';

/**
 * Safe learning (requirement 4, ADR-0009). Nothing users write changes the
 * assistant directly: feedback, corrections and preferences are moderated,
 * queued for my review, and only what I approve becomes memory, tied to the
 * session it came from.
 */

/**
 * A recalled item must be at least this similar to the message (cosine,
 * nomic-embed-text). Chosen on the memory recall eval (`npm run eval:memory`,
 * ADR-0001): at 0.35 three mostly unrelated items went into nearly every
 * prompt; 0.46 had the best balance on the dev messages.
 */
const minSimilarity = 0.46;
/**
 * Always-on items for one session may use at most half of the memory slot, so
 * they always fit and similar items still have room (ADR-0001, ADR-0004).
 */
export const maxAlwaysTokens = contextBudget.memory / 2;

/** At most this many items are recalled for one message (also in the memory recall eval). */
const maxRecalled = 3;

/**
 * Approved memory scored by brute-force cosine in JavaScript: every item was
 * approved by hand, so there are few of them (ADR-0001). Memory is a nicety,
 * so a failed embedding means no memory for that turn, never a failed turn.
 */
export function createMemoryRecall(deps: {
  readonly memory: MemoryRepo;
  readonly embeddings: EmbeddingProvider;
  readonly timeoutMs: number;
}): MemoryRecall {
  return {
    async all(sessionId) {
      return (await deps.memory.list(sessionId)).map((m) => m.content);
    },
    async recall(sessionId, message, signal) {
      // Always-on items come first and never depend on the embedding model:
      // similarity cannot be trusted for things like allergies (ADR-0001).
      const always = (await deps.memory.list(sessionId))
        .filter((m) => m.always)
        .map((m) => m.content);
      const similar = await recallSimilar(sessionId, message, signal);
      return [...always, ...similar];
    },
  };

  async function recallSimilar(
    sessionId: string,
    message: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const items = await deps.memory.withEmbeddings(sessionId);
    if (items.length === 0) return [];
    try {
      const [query] = await deps.embeddings.embed(
        [message],
        AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs)]),
      );
      if (query === undefined) return [];
      return items
        .map((item) => ({
          content: item.content,
          score: cosineSimilarity(query, item.embedding),
        }))
        .filter((s) => s.score >= minSimilarity)
        .sort((x, y) => y.score - x.score)
        .slice(0, maxRecalled)
        .map((s) => s.content);
    } catch (err) {
      if (signal.aborted) throw err;
      return [];
    }
  }
}

/** 'support': the text sounded like self-harm, so the reply carries crisis resources. */
export type FeedbackOutcome = 'queued' | 'dropped' | 'support';

/** Items one session may have waiting for review. */
export const maxPendingPerSession = 20;

export interface FeedbackService {
  submit(
    sessionId: string,
    kind: ReviewKind,
    text: string,
    signal: AbortSignal,
  ): Promise<FeedbackOutcome>;
}

/**
 * Feedback passes the same input guard as a chat message before it is stored.
 * A flagged item is dropped: only its category and the time are recorded.
 */
export function createFeedbackService(deps: {
  readonly inputGuard: InputGuard;
  readonly review: ReviewRepo;
  readonly flags: FlagLog;
}): FeedbackService {
  return {
    async submit(sessionId, kind, text, signal) {
      // A cap per session, so one session cannot fill the queue (and the disk)
      // however many addresses it comes from. Answered like any drop.
      if ((await deps.review.pendingCount(sessionId)) >= maxPendingPerSession) return 'dropped';
      const verdict = await deps.inputGuard.check(text, signal);
      if (!verdict.ok) {
        await deps.flags.record(sessionId, 'refusal' in verdict ? verdict.refusal : 'too_long');
        // Someone in crisis gets the same help as in chat, even though that
        // reveals the outcome; every other drop looks like a queued item.
        return 'refusal' in verdict && verdict.refusal === 'self_harm' ? 'support' : 'dropped';
      }
      await deps.review.add(sessionId, kind, verdict.text);
      return 'queued';
    },
  };
}

export interface Reviewer {
  pending(): Promise<ReviewItem[]>;
  /**
   * Approves an item. A preference or correction becomes memory for its
   * session; feedback is only marked approved. The text is checked by the
   * guard again, which is also the only way to turn it back into storable text.
   */
  approve(
    id: string,
    signal: AbortSignal,
    options?: {
      /** Include the memory in every prompt for its session, for things like allergies. */
      readonly always?: boolean;
    },
  ): Promise<'approved' | 'not_found' | 'refused' | 'always_full'>;
  reject(id: string): Promise<boolean>;
}

export function createReviewer(deps: {
  readonly review: ReviewRepo;
  readonly memory: MemoryRepo;
  readonly embeddings: EmbeddingProvider;
  readonly inputGuard: InputGuard;
}): Reviewer {
  return {
    pending: () => deps.review.pending(),
    async approve(id, signal, options = {}) {
      const item = await deps.review.get(id);
      if (item === undefined) return 'not_found';
      const verdict = await deps.inputGuard.check(item.content, signal);
      if (!verdict.ok) return 'refused';
      if (item.kind === 'feedback') {
        return (await deps.review.decide(id, 'approved')) ? 'approved' : 'not_found';
      }
      // An always-on item is never matched by similarity, so it needs no embedding
      // and does not depend on the embedding model being up.
      const always = options.always === true;
      if (always) {
        // Always-on items must all fit the memory slot on every turn, with room
        // left for similar ones, or some would be dropped without notice.
        const current = (await deps.memory.list(item.sessionId)).filter((m) => m.always);
        const cost = [...current.map((m) => m.content), verdict.text].reduce(
          (sum, text) => sum + estimateTokens(text) + 2,
          0,
        );
        if (cost > maxAlwaysTokens) return 'always_full';
      }
      const [embedding] = always ? [] : await deps.embeddings.embed([verdict.text], signal);
      const memoryId = await deps.memory.add(item.sessionId, verdict.text, embedding, always);
      // The text moves to memory, where the user can see and delete it, so the
      // review row keeps none. If someone decided the item meanwhile, undo.
      if (!(await deps.review.decide(id, 'approved', true))) {
        await deps.memory.delete(item.sessionId, memoryId);
        return 'not_found';
      }
      return 'approved';
    },
    // A rejected item is never used, so its text is not kept either.
    reject: (id) => deps.review.decide(id, 'rejected', true),
  };
}

/**
 * ADR-0009: an eval case never contains user words. A paraphrase is refused if
 * it shares a run of five or more words with the source, or looks like personal
 * data (an email, a phone or card-like number, a URL with a query string, six
 * or more digits in a row).
 */
export function paraphraseProblem(source: string, paraphrase: string): string | undefined {
  const words = (t: string): string[] =>
    t
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w !== '');
  const sourceWords = words(source);
  const runs = new Set<string>();
  for (let i = 0; i + 5 <= sourceWords.length; i++) runs.add(sourceWords.slice(i, i + 5).join(' '));
  const para = words(paraphrase);
  for (let i = 0; i + 5 <= para.length; i++) {
    if (runs.has(para.slice(i, i + 5).join(' ')))
      return 'shares five or more words in a row with the source';
  }
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(paraphrase)) return 'contains an email address';
  if (/\d{6,}/.test(paraphrase.replace(/[\s.()-]/g, '')))
    return 'contains six or more digits in a row';
  if (/https?:\/\/\S*\?/.test(paraphrase)) return 'contains a URL with a query string';
  return undefined;
}
