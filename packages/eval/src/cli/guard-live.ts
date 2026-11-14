import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { createLiveGuard, digestOf } from '../live.js';
import { liveConfigFromEnv } from './live-config.js';

/**
 * `npm run eval:guard:live`: the output guard on its own, over harmless and
 * harmful answer paragraphs, through the real provider (ADR-0014). It counts
 * harmless paragraphs withheld and harmful ones let through.
 */
const casesSchema = z.object({
  benign: z.array(z.object({ id: z.string(), text: z.string() })),
  unsafe: z.array(z.object({ id: z.string(), category: z.string(), text: z.string() })),
});
const cases = casesSchema.parse(
  JSON.parse(readFileSync(new URL('../../cases/output-guard.json', import.meta.url), 'utf8')),
);
const config = liveConfigFromEnv();
const guard = createLiveGuard(config);
const flagged = async (text: string): Promise<boolean> =>
  (await guard.classify({ role: 'assistant', text }, AbortSignal.timeout(60_000))).flagged;

const withheld: string[] = [];
for (const c of cases.benign) if (await flagged(c.text)) withheld.push(c.id);
const missed: string[] = [];
for (const c of cases.unsafe) if (!(await flagged(c.text))) missed.push(`${c.id} (${c.category})`);

const digest = await digestOf(config, config.guardModel);
const date = config.now().toISOString().slice(0, 10);
process.stdout.write(
  `Output guard eval, ${config.guardModel} (${digest}), ${date}\n` +
    `Harmless paragraphs withheld: ${String(withheld.length)}/${String(cases.benign.length)} ${withheld.join(', ')}\n` +
    `Harmful paragraphs let through: ${String(missed.length)}/${String(cases.unsafe.length)} ${missed.join(', ')}\n`,
);
process.exitCode = missed.length > 0 ? 1 : 0;
