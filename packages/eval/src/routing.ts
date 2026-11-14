import { readFileSync } from 'node:fs';

import type { WebTools } from '@local-ai/agent';
import { createAssistant, isTimeSensitive, leakCheckPrompt, personaCanary } from '@local-ai/agent';
import type { ChatProvider, ModerationProvider } from '@local-ai/core';
import { createManualClock } from '@local-ai/core';
import { createInputGuard, createOutputGuard, createOutputRules } from '@local-ai/guardrails';
import { z } from 'zod';

/**
 * The routing eval (ADR-0003): questions labelled by whether a good answer
 * needs information that changes or is newer than the model's training. It
 * measures how often the turn searches, so the recall target is checked
 * against numbers rather than hand-picked prompts.
 */
export const routingCaseSchema = z.strictObject({
  id: z.string().regex(/^routing-\d{3}$/),
  category: z.string().regex(/^[a-z_]+$/),
  message: z.string().min(1).max(500),
  needsSearch: z.boolean(),
  /**
   * `dev` cases were used to shape the router, including two batches written
   * for #57. `heldout` and `heldout4` were each written after the rule they
   * measure and never used to change it, so their numbers are the honest ones.
   */
  split: z.enum(['dev', 'heldout', 'heldout4']),
});

export type RoutingCase = z.infer<typeof routingCaseSchema>;

export function loadRoutingCases(): RoutingCase[] {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../cases/routing.json', import.meta.url), 'utf8'),
  );
  const cases = z.array(routingCaseSchema).parse(raw);
  if (new Set(cases.map((c) => c.id)).size !== cases.length) {
    throw new Error('Routing case ids must be unique.');
  }
  return cases;
}

/** The fixed date the router is measured on, so the result never depends on the day it runs. */
export const routingDate = new Date('2026-11-13T12:00:00Z');

export interface RoutingResult {
  readonly case: RoutingCase;
  readonly searched: boolean;
}

export interface RoutingSummary {
  readonly positives: number;
  readonly negatives: number;
  /** Searched when a search was needed, as a share of the cases that needed one. */
  readonly recall: number;
  /** Searched when no search was needed, as a share of the cases that did not. */
  readonly falsePositiveRate: number;
  readonly missed: readonly RoutingCase[];
  readonly unneeded: readonly RoutingCase[];
}

export function summariseRouting(results: readonly RoutingResult[]): RoutingSummary {
  const positives = results.filter((r) => r.case.needsSearch);
  const negatives = results.filter((r) => !r.case.needsSearch);
  const missed = positives.filter((r) => !r.searched).map((r) => r.case);
  const unneeded = negatives.filter((r) => r.searched).map((r) => r.case);
  return {
    positives: positives.length,
    negatives: negatives.length,
    recall: positives.length === 0 ? 1 : (positives.length - missed.length) / positives.length,
    falsePositiveRate: negatives.length === 0 ? 0 : unneeded.length / negatives.length,
    missed,
    unneeded,
  };
}

/** The rules pre-router alone: a pure function, measured in CI. */
export function routeWithRules(cases: readonly RoutingCase[]): RoutingResult[] {
  return cases.map((c) => ({ case: c, searched: isTimeSensitive(c.message, routingDate) }));
}

export function formatRouting(title: string, s: RoutingSummary): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const lines = [
    title,
    `Needs search: ${String(s.positives)}; no search needed: ${String(s.negatives)}`,
    `Recall: ${pct(s.recall)} (${String(s.positives - s.missed.length)} of ${String(s.positives)})`,
    `Unneeded searches: ${pct(s.falsePositiveRate)} (${String(s.unneeded.length)} of ${String(s.negatives)})`,
  ];
  for (const c of s.missed) lines.push(`  missed    ${c.id} [${c.category}] ${c.message}`);
  for (const c of s.unneeded) lines.push(`  unneeded  ${c.id} [${c.category}] ${c.message}`);
  return lines.join('\n');
}

/** Lets every message through: the routing eval measures search decisions, not moderation. */
const allowAll: ModerationProvider = {
  classify: () => Promise.resolve({ flagged: false }),
};

/**
 * One turn through the real assistant with the given chat model, recording
 * whether it searched, forced by the router or chosen by the model. The turn
 * stops as soon as the answer is decided: at the first search, or when the
 * model starts writing without one.
 */
export type ModelRoute = 'searched' | 'answered' | 'failed';

export async function routeWithModel(
  chat: ChatProvider,
  message: string,
  timeoutMs: number,
): Promise<ModelRoute> {
  let searched = false;
  const web: WebTools = {
    search: {
      run: () => {
        searched = true;
        return Promise.resolve({ ok: true, query: '', results: [] });
      },
    },
    readPage: { run: () => Promise.resolve({ ok: false, error: 'not_allowed' }) },
    nonce: () => '0123456789abcdef0123',
  };
  const guard = { moderation: allowAll, timeoutMs: 1000 };
  const assistant = createAssistant({
    chat,
    inputGuard: createInputGuard(guard),
    outputGuard: createOutputGuard({
      ...guard,
      rules: createOutputRules({ systemPrompt: leakCheckPrompt, canary: personaCanary }),
    }),
    newId: () => '00000000-0000-4000-8000-000000000001',
    turnTimeoutMs: timeoutMs,
    clock: createManualClock(routingDate),
    temperature: 0,
    web,
  });
  const stop = new AbortController();
  for await (const event of assistant.handleTurn({ message, requestId: 'routing' }, stop.signal)) {
    if (event.type === 'status' && event.phase === 'searching') searched = true;
    if (searched) break;
    if (event.type === 'status' && event.phase === 'answering') return 'answered';
    // An outage or timeout says nothing about routing, so it is reported, not
    // counted as an answer without search.
    if (event.type === 'error') return 'failed';
  }
  stop.abort();
  return searched ? 'searched' : 'failed';
}
