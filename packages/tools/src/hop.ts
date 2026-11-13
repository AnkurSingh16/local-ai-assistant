import { lookup } from 'node:dns/promises';

import { Agent, fetch } from 'undici';

import type { HopFetch, Resolve } from './safe-fetch.js';
import { createGuardedLookup } from './safe-fetch.js';

/** The system resolver, returning every address so each one is checked. */
export const systemResolve: Resolve = (host) => lookup(host, { all: true, order: 'verbatim' });

/**
 * The real network hop: undici with the guarded lookup on the connector, a 3 s
 * connect and 5 s headers timeout (ADR-0008), and redirects returned to
 * safeFetch so each one is checked.
 */
export function createUndiciHop(resolve: Resolve = systemResolve): HopFetch {
  const dispatcher = new Agent({
    connect: { lookup: createGuardedLookup(resolve), timeout: 3_000 },
    headersTimeout: 5_000,
    bodyTimeout: 8_000,
  });
  return (url, signal) =>
    fetch(url, {
      dispatcher,
      redirect: 'manual',
      signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'user-agent': 'local-ai-assistant/0.0 (read_page)',
      },
    });
}
