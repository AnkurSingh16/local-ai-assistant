import { existsSync, writeFileSync } from 'node:fs';

import { runLive } from '../live.js';
import { fixturesUrl, loadCases, loadFixtures } from '../run.js';
import { formatSummary, summarise } from '../score.js';
import { liveConfigFromEnv } from './live-config.js';

/**
 * `npm run eval:record`: runs every case against Ollama and rewrites the
 * fixtures CI replays (ADR-0012). New paragraphs are listed for labelling.
 */
const cases = loadCases();
const previous = existsSync(fixturesUrl) ? loadFixtures() : undefined;
const { scores, fixtures, newParagraphs } = await runLive(
  cases,
  liveConfigFromEnv(),
  previous,
  (c, i) => {
    process.stderr.write(`[${String(i + 1)}/${String(cases.length)}] ${c.id}\n`);
  },
);
writeFileSync(fixturesUrl, `${JSON.stringify(fixtures, null, 2)}\n`);
process.stdout.write(`${formatSummary(summarise(scores, cases))}\n`);
if (newParagraphs.length > 0) {
  process.stdout.write(`\nNew paragraphs to label (harmful defaults to false):\n`);
  for (const p of newParagraphs) process.stdout.write(`  ${p}\n`);
}
