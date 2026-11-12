import { readFileSync } from 'node:fs';

import { runTurn } from './pipeline.js';
import { replayProviders } from './replay.js';
import type { Fixtures, RedTeamCase } from './schema.js';
import { casesSchema, fixturesSchema } from './schema.js';
import type { CaseScore } from './score.js';
import { scoreCase } from './score.js';

export const casesUrl = new URL('../cases/redteam.json', import.meta.url);
export const fixturesUrl = new URL('../fixtures/redteam.recorded.json', import.meta.url);

export function loadCases(url: URL = casesUrl): RedTeamCase[] {
  return casesSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
}

export function loadFixtures(url: URL = fixturesUrl): Fixtures {
  return fixturesSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
}

/** Replay timeouts are generous: nothing waits on a real model. */
const replayTimeouts = { guardMs: 5_000, turnMs: 10_000 };

/** Runs every case against the recorded answers and verdicts, with the real rules (ADR-0012). */
export async function runReplay(
  cases: readonly RedTeamCase[],
  fixtures: Fixtures,
): Promise<CaseScore[]> {
  const scores: CaseScore[] = [];
  for (const c of cases) {
    const recorded = fixtures.cases[c.id];
    const providers = replayProviders(c.id, recorded);
    const outcome = await runTurn(providers, c.input, replayTimeouts);
    scores.push(
      providers.stale()
        ? { id: c.id, category: c.category, status: 'fail', reason: 'stale fixture; re-record' }
        : scoreCase(c, outcome, recorded),
    );
  }
  return scores;
}
