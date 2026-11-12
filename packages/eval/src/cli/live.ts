import { runLive } from '../live.js';
import { loadCases, loadFixturesIfAny } from '../run.js';
import { formatSummary, summarise } from '../score.js';
import { liveConfigFromEnv } from './live-config.js';

/** `npm run eval:redteam:live`: the same cases against Ollama, without touching the fixtures. */
const cases = loadCases();
const config = liveConfigFromEnv();
const previous = loadFixturesIfAny();
const { scores, fixtures, newParagraphs } = await runLive(cases, config, previous);
process.stdout.write(
  `Red-team live run ${fixtures.recordedAt}: ${fixtures.chatModel} (${fixtures.chatDigest}), ${fixtures.guardModel} (${fixtures.guardDigest}), persona ${fixtures.personaVersion}\n`,
);
process.stdout.write(`${formatSummary(summarise(scores, cases))}\n`);
process.stdout.write(`Unlabelled new paragraphs: ${String(newParagraphs.length)}\n`);
process.exitCode = summarise(scores, cases).failures.length > 0 ? 1 : 0;
