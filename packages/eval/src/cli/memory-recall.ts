import { createLiveEmbeddings, digestOf } from '../live.js';
import { atThreshold, bestThreshold, loadRecallSet, scorePairs } from '../memory-recall.js';
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
process.stdout.write(`Memory recall eval, ${model} (${digest}), current threshold 0.35\n`);
for (const [name, prefixes] of [
  ['no prefixes', { query: '', document: '' }],
  ['nomic prefixes', { query: 'search_query: ', document: 'search_document: ' }],
] as const) {
  const pairs = await scorePairs(set, embeddings, prefixes, AbortSignal.timeout(120_000));
  const dev = pairs.filter((p) => p.split === 'dev');
  const held = pairs.filter((p) => p.split === 'heldout');
  const best = bestThreshold(dev);
  for (const [label, t] of [
    ['current 0.35', 0.35],
    [`best on dev ${best.threshold.toFixed(2)}`, best.threshold],
  ] as const) {
    const d = atThreshold(dev, t);
    const h = atThreshold(held, t);
    process.stdout.write(
      `${name}, ${label}: dev recall ${pct(d.recall)} precision ${pct(d.precision)}; held-out recall ${pct(h.recall)} precision ${pct(h.precision)}\n`,
    );
  }
}
