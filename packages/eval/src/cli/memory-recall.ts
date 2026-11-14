import { createLiveEmbeddings, digestOf } from '../live.js';
import {
  alwaysItemCoverage,
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
  const best = bestThreshold(dev, productionTopK);
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

// The API recalls always-on items for every message (#55). These lines show
// what similarity alone would have done for them, and the API's figures with them.
const plain = await scorePairs(
  set,
  embeddings,
  { query: '', document: '' },
  AbortSignal.timeout(120_000),
);
for (const c of alwaysItemCoverage(plain, apiThreshold, productionTopK)) {
  process.stdout.write(
    `always-on ${c.itemId}: by similarity alone recalled for ${String(c.bySimilarity)} of ${String(c.needed)} messages that need it; always-on, ${String(c.needed)} of ${String(c.needed)}\n`,
  );
}
for (const [split, list] of [
  ['dev', plain.filter((p) => p.split === 'dev')],
  ['held-out', plain.filter((p) => p.split === 'heldout')],
] as const) {
  const r = atThreshold(list, apiThreshold, productionTopK, true);
  process.stdout.write(
    `API ${apiThreshold.toFixed(2)} with always-on items, ${split}: recall ${pct(r.recall)} precision ${pct(r.precision)}\n`,
  );
}
