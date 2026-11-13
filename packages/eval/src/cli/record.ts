import { writeFileSync } from 'node:fs';

import { runLive } from '../live.js';
import { fixturesUrl, loadCases, loadFixturesIfAny } from '../run.js';
import { formatSummary, summarise } from '../score.js';
import { liveConfigFromEnv } from './live-config.js';

/**
 * `npm run eval:record`: runs every case against Ollama and rewrites the
 * fixtures CI replays (ADR-0012). New paragraphs are listed for labelling.
 */
const allCases = loadCases();
const previous = loadFixturesIfAny();
// `--only=id1,id2` re-records just those cases and keeps every other fixture as it is,
// for when a code change makes a few recordings stale.
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only =
  onlyArg === undefined ? undefined : new Set(onlyArg.slice('--only='.length).split(','));
const cases = only === undefined ? allCases : allCases.filter((c) => only.has(c.id));
if (only !== undefined && cases.length !== only.size) {
  process.stderr.write('Some --only ids are not in the case set.\n');
  process.exit(1);
}
const {
  scores,
  fixtures: recorded,
  newParagraphs,
} = await runLive(cases, liveConfigFromEnv(), previous, (c, i) => {
  process.stderr.write(`[${String(i + 1)}/${String(cases.length)}] ${c.id}\n`);
});
const fixtures =
  only === undefined || previous === undefined
    ? recorded
    : { ...previous, cases: { ...previous.cases, ...recorded.cases } };
writeFileSync(fixturesUrl, `${JSON.stringify(fixtures, null, 2)}\n`);
process.stdout.write(`${formatSummary(summarise(scores, cases))}\n`);
// A case the guard never answered, even after retries, recorded nothing real.
const empty = cases.filter((c) => {
  const rc = recorded.cases[c.id];
  return (
    rc !== undefined &&
    rc.synthetic !== true &&
    rc.input === undefined &&
    rc.answer === undefined &&
    scores.some((s) => s.id === c.id && s.reason.includes('unavailable'))
  );
});
if (empty.length > 0) {
  process.stdout.write(
    `\nGuard never answered for: ${empty.map((c) => c.id).join(', ')}; re-record them with --only.\n`,
  );
  process.exitCode = 1;
}
if (newParagraphs.length > 0) {
  process.stdout.write(
    `\nNew paragraphs to label (harmful is null until labelled; the tests fail until then):\n`,
  );
  for (const p of newParagraphs) process.stdout.write(`  ${p}\n`);
}
