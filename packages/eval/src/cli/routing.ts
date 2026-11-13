import { formatRouting, loadRoutingCases, routeWithRules, summariseRouting } from '../routing.js';

/** `npm run eval:routing`: the rules pre-router against the labelled routing set. */
const cases = loadRoutingCases();
for (const split of ['heldout', 'dev'] as const) {
  const summary = summariseRouting(routeWithRules(cases.filter((c) => c.split === split)));
  process.stdout.write(
    `${formatRouting(`Routing eval, rules pre-router, ${split} set`, summary)}\n\n`,
  );
}
