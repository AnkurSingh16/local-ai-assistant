import { loadCases, loadFixtures, runReplay } from '../run.js';
import { formatSummary, summarise } from '../score.js';

/** `npm run eval:redteam`: the CI red-team run, replaying recorded outputs (ADR-0012). */
const cases = loadCases();
const fixtures = loadFixtures();
const summary = summarise(await runReplay(cases, fixtures), cases);
process.stdout.write(
  `Red-team replay, recorded ${fixtures.recordedAt} with ${fixtures.chatModel} (${fixtures.chatDigest}) and ${fixtures.guardModel} (${fixtures.guardDigest})\n`,
);
process.stdout.write(`${formatSummary(summary)}\n`);
process.exitCode = summary.failures.length > 0 ? 1 : 0;
