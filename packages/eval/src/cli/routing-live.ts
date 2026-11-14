import type { RoutingResult } from '../routing.js';
import { formatRouting, loadRoutingCases, routeWithModel, summariseRouting } from '../routing.js';
import { createLiveChat, digestOf } from '../live.js';
import { liveConfigFromEnv } from './live-config.js';

/**
 * `npm run eval:routing:live`: whole turns against the chat model, counting a
 * search forced by the router or chosen by the model (ADR-0003).
 */
const config = liveConfigFromEnv();
const chat = createLiveChat(config);
const digest = await digestOf(config, config.chatModel);
const cases = loadRoutingCases();
const results: RoutingResult[] = [];
const failed: string[] = [];
for (const [i, c] of cases.entries()) {
  process.stderr.write(`[${String(i + 1)}/${String(cases.length)}] ${c.id}\n`);
  // Another Ollama client can make a model reload and time out; try again
  // before counting the case as failed, and leave failed cases out of the figures.
  let route = await routeWithModel(chat, c.message, 120_000);
  for (let attempt = 1; route === 'failed' && attempt < 3; attempt++) {
    route = await routeWithModel(chat, c.message, 120_000);
  }
  if (route === 'failed') failed.push(c.id);
  else results.push({ case: c, searched: route === 'searched' });
}
const date = config.now().toISOString().slice(0, 10);
for (const split of ['heldout2', 'heldout', 'dev'] as const) {
  const summary = summariseRouting(results.filter((r) => r.case.split === split));
  process.stdout.write(
    `${formatRouting(`Routing eval, whole turns with ${config.chatModel} (${digest}), ${date}, ${split} set`, summary)}\n\n`,
  );
}
process.stdout.write(
  `Failed after retries (left out): ${failed.length === 0 ? 'none' : failed.join(', ')}\n`,
);
