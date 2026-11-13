import type { MemoryRecall } from '@local-ai/agent';
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
 * ADR-0001): at 0.35 nearly every item passed, so unrelated memory filled the
 * prompt; 0.46 had the best balance on the dev messages.
 */
const minSimilarity = 0.46;
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
    },
  };
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
  approve(id: string, signal: AbortSignal): Promise<'approved' | 'not_found' | 'refused'>;
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
    async approve(id, signal) {
      const item = await deps.review.get(id);
      if (item === undefined) return 'not_found';
      const verdict = await deps.inputGuard.check(item.content, signal);
      if (!verdict.ok) return 'refused';
      if (item.kind === 'feedback') {
        return (await deps.review.decide(id, 'approved')) ? 'approved' : 'not_found';
      }
      const [embedding] = await deps.embeddings.embed([verdict.text], signal);
      const memoryId = await deps.memory.add(item.sessionId, verdict.text, embedding);
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
