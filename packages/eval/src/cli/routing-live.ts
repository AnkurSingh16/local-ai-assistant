import { formatRouting, loadRoutingCases, routeWithModel, summariseRouting } from '../routing.js';
import { createLiveChat } from '../live.js';
import { liveConfigFromEnv } from './live-config.js';

/**
 * `npm run eval:routing:live`: whole turns against the chat model, counting a
 * search forced by the router or chosen by the model (ADR-0003).
 */
const config = liveConfigFromEnv();
const chat = createLiveChat(config);
const cases = loadRoutingCases();
const results = [];
for (const [i, c] of cases.entries()) {
  process.stderr.write(`[${String(i + 1)}/${String(cases.length)}] ${c.id}\n`);
  results.push({ case: c, searched: await routeWithModel(chat, c.message, 120_000) });
}
const date = config.now().toISOString().slice(0, 10);
for (const split of ['heldout', 'dev'] as const) {
  const summary = summariseRouting(results.filter((r) => r.case.split === split));
  process.stdout.write(
    `${formatRouting(`Routing eval, whole turns with ${config.chatModel}, ${date}, ${split} set`, summary)}\n\n`,
  );
}
