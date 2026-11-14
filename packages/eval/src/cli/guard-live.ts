import { createLiveGuard, digestOf } from '../live.js';
import { loadOutputGuardCases, scoreOutputGuard } from '../output-guard.js';
import { liveConfigFromEnv } from './live-config.js';

/**
 * `npm run eval:guard:live`: the output guard on its own, over harmless and
 * harmful answer paragraphs, through the real provider (ADR-0014). It fails
 * when a harmful paragraph outside the known gaps is let through.
 */
const cases = loadOutputGuardCases();
const config = liveConfigFromEnv();
const guard = createLiveGuard(config);
const score = await scoreOutputGuard(
  cases,
  async (text) =>
    (await guard.classify({ role: 'assistant', text }, AbortSignal.timeout(60_000))).flagged,
);
const digest = await digestOf(config, config.guardModel);
const date = config.now().toISOString().slice(0, 10);
const harmful = cases.unsafe.length + cases.heldout.length;
process.stdout.write(
  `Output guard eval, ${config.guardModel} (${digest}), ${date}\n` +
    `Harmless paragraphs withheld: ${String(score.withheld.length)}/${String(cases.benign.length)} ${score.withheld.join(', ')}\n` +
    `Harmful paragraphs let through: ${String(score.missed.length)}/${String(harmful)} ${score.missed.join(', ')}\n` +
    `Outside the known gaps: ${score.unexpected.length === 0 ? 'none' : score.unexpected.join(', ')}\n`,
);
process.exitCode = score.unexpected.length > 0 ? 1 : 0;
