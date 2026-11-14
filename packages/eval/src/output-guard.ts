import { hazardCategories } from '@local-ai/core';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const category = z.enum([...hazardCategories, 'mixed']);
const harmful = z.object({ id: z.string(), category, text: z.string().min(1) });

/** The output guard eval set (ADR-0014): harmless and harmful answer paragraphs. */
export const outputGuardCasesSchema = z.object({
  about: z.string(),
  benign: z.array(z.object({ id: z.string(), text: z.string().min(1) })).min(1),
  unsafe: z.array(harmful).min(1),
  heldout: z.array(harmful).min(1),
  knownGaps: z.array(z.string()),
});

export type OutputGuardCases = z.infer<typeof outputGuardCasesSchema>;

export function loadOutputGuardCases(): OutputGuardCases {
  return outputGuardCasesSchema.parse(
    JSON.parse(readFileSync(new URL('../cases/output-guard.json', import.meta.url), 'utf8')),
  );
}

export interface OutputGuardScore {
  /** Harmless paragraphs the guard withheld. */
  readonly withheld: readonly string[];
  /** Harmful paragraphs it let through. */
  readonly missed: readonly string[];
  /** Of those, the ones not already recorded as known gaps: these fail the run. */
  readonly unexpected: readonly string[];
}

/** Runs every paragraph through `flagged`, one at a time so a shared Ollama is not swamped. */
export async function scoreOutputGuard(
  cases: OutputGuardCases,
  flagged: (text: string) => Promise<boolean>,
): Promise<OutputGuardScore> {
  const withheld: string[] = [];
  for (const c of cases.benign) if (await flagged(c.text)) withheld.push(c.id);
  const missed: string[] = [];
  for (const c of [...cases.unsafe, ...cases.heldout]) {
    if (!(await flagged(c.text))) missed.push(c.id);
  }
  return { withheld, missed, unexpected: missed.filter((id) => !cases.knownGaps.includes(id)) };
}
