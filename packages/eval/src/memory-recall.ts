import { readFileSync } from 'node:fs';

import type { EmbeddingProvider } from '@local-ai/core';
import { z } from 'zod';

/**
 * The memory recall eval (ADR-0001): approved memory items and messages, each
 * labelled with the items a good answer should take into account. It measures
 * how well a cosine threshold on nomic-embed-text separates the two, so the
 * threshold is chosen from numbers. Items that apply to every message (style
 * preferences such as "keep answers short") are left out of the labels:
 * similarity cannot find them, and that limit is reported separately.
 */
const setSchema = z.strictObject({
  items: z.array(z.strictObject({ id: z.string(), text: z.string().min(1) })),
  messages: z.array(
    z.strictObject({
      id: z.string(),
      message: z.string().min(1),
      relevant: z.array(z.string()),
      split: z.enum(['dev', 'heldout']),
    }),
  ),
});

export type RecallSet = z.infer<typeof setSchema>;

export function loadRecallSet(): RecallSet {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../cases/memory-recall.json', import.meta.url), 'utf8'),
  );
  const set = setSchema.parse(raw);
  const ids = new Set(set.items.map((i) => i.id));
  for (const m of set.messages) {
    for (const r of m.relevant) if (!ids.has(r)) throw new Error(`Unknown item ${r} in ${m.id}`);
  }
  return set;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

const empty = new Float32Array(0);

export interface ScoredPair {
  readonly split: 'dev' | 'heldout';
  readonly relevant: boolean;
  readonly score: number;
}

/** Every message paired with every item, with its cosine score and label. */
export async function scorePairs(
  set: RecallSet,
  embeddings: EmbeddingProvider,
  prefixes: { readonly query: string; readonly document: string },
  signal: AbortSignal,
): Promise<ScoredPair[]> {
  const itemVectors = await embeddings.embed(
    set.items.map((i) => `${prefixes.document}${i.text}`),
    signal,
  );
  const messageVectors = await embeddings.embed(
    set.messages.map((m) => `${prefixes.query}${m.message}`),
    signal,
  );
  const pairs: ScoredPair[] = [];
  set.messages.forEach((m, mi) => {
    set.items.forEach((item, ii) => {
      pairs.push({
        split: m.split,
        relevant: m.relevant.includes(item.id),
        score: cosine(messageVectors[mi] ?? empty, itemVectors[ii] ?? empty),
      });
    });
  });
  return pairs;
}

export interface ThresholdResult {
  readonly threshold: number;
  readonly recall: number;
  readonly precision: number;
  readonly f1: number;
}

export function atThreshold(pairs: readonly ScoredPair[], threshold: number): ThresholdResult {
  const kept = pairs.filter((p) => p.score >= threshold);
  const relevant = pairs.filter((p) => p.relevant).length;
  const hits = kept.filter((p) => p.relevant).length;
  const recall = relevant === 0 ? 1 : hits / relevant;
  const precision = kept.length === 0 ? 1 : hits / kept.length;
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return { threshold, recall, precision, f1 };
}

/** The threshold with the best F1 on the given pairs, from 0.30 to 0.80 in steps of 0.01. */
export function bestThreshold(pairs: readonly ScoredPair[]): ThresholdResult {
  let best = atThreshold(pairs, 0.3);
  for (let t = 31; t <= 80; t++) {
    const r = atThreshold(pairs, t / 100);
    if (r.f1 > best.f1) best = r;
  }
  return best;
}
