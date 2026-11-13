import { createLiveEmbeddings, digestOf } from '../live.js';
import {
  atThreshold,
  bestThreshold,
  loadRecallSet,
  productionTopK,
  scorePairs,
} from '../memory-recall.js';
import { embedModelFromEnv, liveConfigFromEnv } from './live-config.js';

/**
 * `npm run eval:memory`: how well a cosine threshold on nomic-embed-text
 * separates relevant memory from the rest, with and without the model's
 * search_query: / search_document: prefixes. The threshold is chosen on the
 * dev messages and reported on the held-out ones.
 */
const config = liveConfigFromEnv();
const model = embedModelFromEnv();
const embeddings = createLiveEmbeddings(config, model);
const digest = await digestOf(config, model);
const set = loadRecallSet();
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
// The API's threshold (apps/api/src/learning.ts); the eval cannot import apps.
const apiThreshold = 0.46;
process.stdout.write(
  `Memory recall eval, ${model} (${digest}); per message at most ${String(productionTopK)} items, as the API recalls\n`,
);
for (const [name, prefixes] of [
  ['no prefixes', { query: '', document: '' }],
  ['nomic prefixes', { query: 'search_query: ', document: 'search_document: ' }],
] as const) {
  const pairs = await scorePairs(set, embeddings, prefixes, AbortSignal.timeout(120_000));
  const dev = pairs.filter((p) => p.split === 'dev');
  const held = pairs.filter((p) => p.split === 'heldout');
  const best = bestThreshold(dev);
  for (const [label, t] of [
    ['first guess 0.35', 0.35],
    [`API ${apiThreshold.toFixed(2)}`, apiThreshold],
    [`best on dev ${best.threshold.toFixed(2)}`, best.threshold],
  ] as const) {
    const d = atThreshold(dev, t, productionTopK);
    const h = atThreshold(held, t, productionTopK);
    process.stdout.write(
      `${name}, ${label}: dev recall ${pct(d.recall)} precision ${pct(d.precision)}; held-out recall ${pct(h.recall)} precision ${pct(h.precision)}\n`,
    );
  }
}
