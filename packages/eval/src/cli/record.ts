import { writeFileSync } from 'node:fs';

import { personaVersion } from '@local-ai/agent';

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
// Checked before running, so a refused partial re-record costs nothing.
if (only !== undefined && previous !== undefined && previous.personaVersion !== personaVersion) {
  process.stderr.write('The persona changed since the last recording; re-record everything.\n');
  process.exit(1);
}
const {
  scores,
  fixtures: recorded,
  newParagraphs,
  outages,
  retried,
} = await runLive(
  cases,
  liveConfigFromEnv(),
  previous,
  (c, i) => {
    process.stderr.write(`[${String(i + 1)}/${String(cases.length)}] ${c.id}\n`);
  },
  (c, attempt) => {
    process.stderr.write(`  retrying ${c.id} (attempt ${String(attempt)})\n`);
  },
);
// A partial re-record must match the header it is merged into, or the fixture
// would claim one persona and model set while mixing two.
if (
  only !== undefined &&
  previous !== undefined &&
  (previous.personaVersion !== recorded.personaVersion ||
    previous.chatDigest !== recorded.chatDigest ||
    previous.guardDigest !== recorded.guardDigest)
) {
  process.stderr.write(
    'The persona or a model changed since the last recording; re-record everything.\n',
  );
  process.exit(1);
}
const fixtures =
  only === undefined || previous === undefined
    ? recorded
    : { ...previous, cases: { ...previous.cases, ...recorded.cases } };
writeFileSync(fixturesUrl, `${JSON.stringify(fixtures, null, 2)}\n`);
process.stdout.write(`${formatSummary(summarise(scores, cases))}\n`);
if (retried.length > 0) process.stdout.write(`\nRetried after an outage: ${retried.join(', ')}\n`);
// A case that still ended in a guard outage or an error recorded nothing real.
if (outages.length > 0) {
  process.stdout.write(
    `\nStill failing after retries: ${outages.join(', ')}; re-record them with --only.\n`,
  );
  process.exitCode = 1;
}
if (newParagraphs.length > 0) {
  process.stdout.write(
    `\nNew paragraphs to label (harmful is null until labelled; the tests fail until then):\n`,
  );
  for (const p of newParagraphs) process.stdout.write(`  ${p}\n`);
}
