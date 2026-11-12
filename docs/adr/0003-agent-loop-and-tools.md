# ADR-0003: Agent loop with native tool calling, forced search and a taint rule

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Ankur Pawar

## Context

Each turn the assistant decides whether to answer from model knowledge or search. Time-sensitive questions (recent events, prices, scores, releases, people's current roles) must go through search. Fetched pages are untrusted, approved memory is private, and search queries leave the machine: the combination Simon Willison calls the lethal trifecta. A page must not be able to steer the model into sending private data out in a URL or a query.

## Options considered

1. **Ollama native tool calling.** The model chooses tools. Less code, but a 7B model's tool choice is not reliable on its own.
2. **A JSON or ReAct prompt protocol.** Portable to models without tool support, but about 150 lines of parser and repair code, and more brittle on a 7B model.
3. **A deterministic pre-router only.** Testable, but rules miss paraphrases.
4. **Native tool calling plus a deterministic pre-router that forces search** on turns it marks time-sensitive.

## Decision

Option 4.

- **Routing.** A rules pre-router in `agent` marks a turn time-sensitive (words such as current, latest, today, now, price, score, "who is the CEO", release, and years at or after the model's training cutoff). On those turns a `web_search` runs before generation; the model cannot skip it. On other turns the model may call `web_search` itself. Routing is a pure function of the rules verdict and the model's tool calls, so it is unit-tested with the mock chat provider.
- **Who writes the forced query.** The chat model, through a structured-output call limited to 200 characters, never the raw user message. The query passes the same personal-data check as stored text before it goes out, so a message containing an email address or phone number does not get sent to search engines.
- **Budgets per turn.** One `web_search` (up to 5 results), then up to two `read_page` calls. Four model steps in total. Timeouts: search 5 s, each page read 8 s, the whole turn 60 s.
- **Taint rule.** A turn starts clean. After search results are in context, the only tool allowed is `read_page`, and only on exact URLs returned by this turn's search. After page text is in context, no further search is allowed. The model can never fetch a URL invented by a page or a user, which closes exfiltration through query strings to a public host.
- **Validation.** Every tool call is parsed with its Zod schema. An unknown tool or invalid arguments produce an error result for the model, not a retry loop.
- **Cancellation.** One signal per turn, `AbortSignal.any([clientAbort, AbortSignal.timeout(60_000)])`, passed to Ollama, SearXNG, every fetch and the parse worker.
- **Output links.** The answer may link only to entries in the citation list, and clients never render Markdown images, which are the classic exfiltration channel.
- **`get_current_datetime`** reads the injected `Clock`.
- **Persona as code.** The persona and style guide are versioned files in `packages/agent/persona/`. Changing them triggers the red-team workflow, because an unreviewed prompt change is exactly what went wrong at xAI.

## Consequences

- Searches are capped, which can leave a hard multi-part question under-researched. I accept that for a demo; a second search can be added later if the eval shows a need and the taint rule still holds.
- Forced search costs about one extra model call (the query) on time-sensitive turns.
- Routing quality on the real model is measured with a routing eval set in `eval`. I target at least 95% recall on time-sensitive prompts and report the number exactly as measured.

## Evidence

- Spike on 2026-11-12 with `qwen2.5:7b` (Q4_K_M) at temperature 0: native tool routing was right on 11 of 12 hand-picked prompts; the miss was an unnecessary search. Twelve prompts prove little, which is why the routing eval exists.
- A tool decision took about 1 s once the model was loaded; generation ran at about 26 tokens/s.
- OWASP LLM01 Prompt Injection and LLM06 Excessive Agency (2025): https://genai.owasp.org/llmrisk/llm01-prompt-injection/ and https://genai.owasp.org/llmrisk/llm062025-excessive-agency/ (accessed 2026-11-12).
