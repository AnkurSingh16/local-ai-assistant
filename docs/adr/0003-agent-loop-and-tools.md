# ADR-0003: Agent loop with native tool calling, forced search and a taint rule

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Ankur Pawar

## Context

Each turn the assistant decides whether to answer from model knowledge or search. Time-sensitive questions (recent events, prices, scores, releases, people's current roles) must go through search. Fetched pages are untrusted, approved memory is private, and search queries leave the machine: the combination Simon Willison calls the [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/). A page must not be able to steer the model into sending private data out in a URL or a query.

## Options considered

1. **Ollama native tool calling.** The model chooses tools. Less code, but a 7B model's tool choice is not reliable on its own.
2. **A JSON or ReAct prompt protocol.** Portable to models without tool support, but about 150 lines of parser and repair code, and more brittle on a 7B model.
3. **A deterministic pre-router only.** Testable, but rules miss paraphrases.
4. **Native tool calling plus a deterministic pre-router that forces search** on turns it marks time-sensitive.

## Decision

Option 4.

- **Routing.** A rules pre-router in `agent` marks a turn time-sensitive (words such as current, latest, today, now, price, score, "who is the CEO", release, and years at or after the model's training cutoff). On those turns a `web_search` runs before generation; the model cannot skip it. On other turns the model may call `web_search` itself. Routing is a pure function of the rules verdict and the model's tool calls, so it is unit-tested with the mock chat provider.
- **Who writes the forced query.** The chat model, through a structured-output call limited to 200 characters, never the raw user message. Before it goes out, the query is rejected (and the turn answered without search, saying so) if it matches the personal-data patterns in [ADR-0009](0009-sessions-and-memory-deletion.md) or shares a run of four or more words with any approved memory item, so private details do not reach search engines.
- **Budgets per turn.** One `web_search` (up to 5 results), then up to two `read_page` calls. Four model steps in total. Timeouts: search 5 s, each page read 10 s (8 s fetch plus 2 s parse, [ADR-0008](0008-fetch-safety.md)), the whole turn 60 s.
- **Taint rule.** A turn starts clean. After search results are in context, the only tools allowed are `get_current_datetime` (it reads only the clock) and `read_page`, and `read_page` only on exact URLs returned by this turn's search. After page text is in context, no further search is allowed. The model can never fetch a URL invented by a page or a user, which closes exfiltration through query strings to a public host.
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

**Amended 2026-11-14 (routing eval).** The routing eval is in `packages/eval/cases/routing.json`: 290 questions labelled by whether a good answer needs information that changes or is newer than the model's training. It has two parts. The `dev` set (190 questions) is the one I shaped the rules against, including 26 hard negatives a reviewer found. The `heldout` set (100 questions) was written afterwards and never used to change anything: 30 that need search, 30 ordinary questions, and 40 hard negatives that use the same trigger words ("still", "cheapest", "temperature", "next", "who leads") without asking about now. `npm run eval:routing` measures the rules pre-router, and CI checks floors on the dev set only, so the held-out set never becomes a target. `npm run eval:routing:live` measures whole turns against the chat model, counting a search forced by the router or chosen by the model; turns that end in an outage are retried and, if they still fail, left out and listed.

The broad rules apply only to factual questions about the world. They never fire on questions that mention the user, the assistant or people around them ("is my lump still worth checking", "how are you feeling today"), because a forced query is a paraphrase of the message and would carry private context to a search engine. Words that are only sometimes about now ("still", "cost", "cheapest", "temperature", "next", "who leads") need a time word or a named thing (a capitalised name) as well. No red-team input is forced to search, and a test keeps it that way so the recorded red-team answers stay valid.

| Measured 2026-11-13 (UTC), `qwen2.5:7b` 845dbda0ea48 | Rules alone, dev | Rules alone, held-out | Whole turns, held-out |
| ---------------------------------------------------- | ---------------- | --------------------- | --------------------- |
| Recall on questions that need search                 | 94.0% (79 of 84) | 66.7% (20 of 30)      | 70.0% (21 of 30)      |
| Unneeded searches                                    | 0% (0 of 106)    | 5.7% (4 of 70)        | 5.7% (4 of 70)        |

Before the broader rules, the rules alone reached 46% and whole turns 56% on the first 104 questions. The 95% target is **not met** on unseen questions. Each round of rules reached about 95% on the questions it was shaped against and about two-thirds on new ones, so more keyword rules would chase the test set rather than generalise. The four unneeded held-out searches are factual questions with a trigger word, such as "What is the temperature of the Sun's surface?": harmless to send, but a search the turn did not need. I also tried one yes/no call to `qwen2.5:7b` asking whether a question needs current information. It added nothing on the held-out set: asked "Is there a new MacBook Air out?", the model answers "No", because it believes its training covers it. I did not ship it. The gap is a limit of a small local model; the production guide's hosted models are the way to close it, measured with this same eval.
