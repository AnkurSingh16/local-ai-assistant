# ADR-0008: Fetch safety for read_page

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Ankur Pawar

## Context

`read_page` fetches arbitrary public pages chosen from search results. Without care it can reach Ollama on localhost, SearXNG, my router or cloud metadata (SSRF), be redirected there, be pointed there by DNS rebinding, or hang the API on a huge or pathological page. Ollama has had a DNS rebinding vulnerability (CVE-2024-28224) and a path-traversal-to-RCE bug (CVE-2024-37032).

## Options considered

1. **Check the hostname once, then fetch with redirects followed.** Loses to DNS rebinding and to a redirect to a private address.
2. **An egress proxy** such as smokescreen. Strong, but one more process.
3. **Check addresses inside the socket's DNS lookup, handle redirects manually, and parse in a worker thread.**

## Decision

Option 3, as one `safeFetch(url, signal)` in `packages/tools`, applied on every hop:

1. Parse with the WHATWG `URL`. Allow `https:` only, port 443 only, no user info. Reject IP-literal hosts outright, because undici skips the custom lookup for them.
2. Resolve in the custom `lookup` passed to an undici `Agent({ connect: { lookup } })`, so the address that was checked is the address the socket connects to. Use `dns.lookup(host, { all: true })` and reject the host if any address is not public: `ipaddr.js` `range() === 'unicast'` after unwrapping IPv4-mapped IPv6, and for IPv6, also inside 2000::/3.
3. `redirect: 'manual'`, at most 3 hops, the full check on every hop, never downgrading from https.
4. Limits: connect 3 s, headers 5 s, total 8 s for the fetch; the body is streamed and cut off at 1 MB of decoded bytes, whatever `Content-Length` says, which also stops decompression bombs.
5. Content types: `text/html`, `application/xhtml+xml`, `text/plain`.
6. Parsing runs in a `worker_thread`: jsdom with scripts and resource loading off, then Readability, with the text cut to 1,000 tokens ([ADR-0004](0004-context-budget-and-history.md)). The worker gets `resourceLimits.maxOldGenerationSizeMb: 256` and is terminated if parsing exceeds 2 s. At most 2 parses run at once. A page read therefore takes at most 10 s: 8 s to fetch and 2 s to parse.
7. **Wrapping.** The wrapping function is the only place that mints `UntrustedWebText` ([ADR-0002](0002-packages-interfaces-boundaries.md)). Page text and search snippets go to the model inside a delimiter with a random per-request nonce (`<web_content id="2" nonce="...">`); any occurrence of the delimiter inside the content is removed, template tokens are neutralised, and pages that trip the injection rules are dropped. The system prompt says this content is material to cite, never instructions. This reduces injection; the taint rule in [ADR-0003](0003-agent-loop-and-tools.md) is what bounds the damage.

## Consequences

- One more dependency, `ipaddr.js` (no dependencies of its own), instead of a hand-maintained range list that already missed a case in testing.
- A custom undici dispatcher ignores HTTP proxy settings; that needs revisiting if a proxy is ever required.
- The worker adds about a millisecond of messaging, and keeps timers (guard timeouts, the turn deadline, SSE pings) running while a page is parsed.

## Evidence

Measured on my M1 Pro, Node 24.22.3, 2026-11-12:

- undici did not call `connect.lookup` for `https://127.0.0.1`, `https://[::1]`, `https://0x7f000001` or `https://[::ffff:7f00:1]`; all four reached the socket. With hostnames, the lookup blocked `localhost` and `127.0.0.1.nip.io` and allowed `example.com`.
- `ipaddr.js` 2.5 with the 2000::/3 check blocked every case tested, including `::127.0.0.1`, which a hand-written `net.BlockList` missed.
- On a 2 MB article, jsdom parsing took 393 ms and Readability 1,182 ms, about 1.6 s in total, too close to a 2 s limit; on a 2 MB page of repeated divs, parsing took 632 ms and Readability 29,705 ms; a 2 MB page nested 100,000 levels deep had not finished after 150 s. No timer fires on the main thread during a synchronous parse. A separate run on synthetic HTML measured 296 ms at 1 MB and 511 ms at 2 MB; scaling the 2 MB article result suggests a real 1 MB article parses in roughly 0.8 s. That is why I cap pages at 1 MB and keep the 2 s limit, and the worker kill bounds the cases that exceed it. In a worker, the div-soup parse was terminated at 2,079 ms and the main thread never stalled for more than 2 ms. A 2 MB parse used 439 MB of resident memory, which is why the worker has a heap limit and parses are capped at 2 concurrent.
- CVE-2024-28224: https://www.nccgroup.com/research/technical-advisory-ollama-dns-rebinding-attack-cve-2024-28224/ ; CVE-2024-37032: https://www.wiz.io/blog/probllama-ollama-vulnerability-cve-2024-37032 ; CVE-2024-29415 (the `ip` package misclassifying addresses, the reason I avoid it): https://nvd.nist.gov/vuln/detail/CVE-2024-29415 (all accessed 2026-11-12).
