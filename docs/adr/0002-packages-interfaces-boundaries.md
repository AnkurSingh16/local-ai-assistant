# ADR-0002: Package layout, provider interfaces and guard boundaries

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Ankur Pawar
- **Amended:** 2026-11-12. The package table listed mock providers under both `core` and `providers`; they live only in `providers` (`@local-ai/providers/mock`). The cast ban is a type-aware ESLint rule rather than a syntax selector, because a selector on the type name missed aliases, renamed imports and qualified names.

## Context

Providers (chat, search, embeddings, moderation) must be swappable for hosted APIs later, tests must run on mocks, and no new route or tool may reach the chat model or storage without passing the guardrails. A boundary that relies on code review alone is the kind that failed in the Grok incident, where an unreviewed change reached production.

## Options considered

1. **A few large packages** (fold guardrails, tools and the agent into `core`). Fewer `package.json` files, but vendor code and jsdom leak into core and boundaries become unenforceable.
2. **Fine-grained packages with mechanical checks** (dependency-cruiser rules, a branded type and a route-inventory test).
3. **A DI container** (awilix, tsyringe). Runtime wiring errors that strict types would otherwise catch, for about ten injectables.

## Decision

Nine packages and three apps:

| Package      | Holds                                                                           |
| ------------ | ------------------------------------------------------------------------------- |
| `core`       | Domain types, provider interfaces, `Clock`, `ModeratedText`                     |
| `contract`   | Zod schemas for API requests and SSE events, shared by the API and both clients |
| `agent`      | The agent loop, routing, context budget, persona assembly                       |
| `guardrails` | Normalisation, rules, moderation pipeline, hold-back buffer, refusal templates  |
| `tools`      | `web_search`, `read_page`, `get_current_datetime`, safe fetch, the parse worker |
| `providers`  | Ollama and SearXNG adapters and mock providers                                  |
| `storage`    | SQLite repositories and migrations                                              |
| `client`     | Headless SSE client over `fetch`                                                |
| `eval`       | Red-team and routing sets and the runner                                        |

Apps: `apps/api` (Fastify), `apps/web` (React 19 + Vite), `apps/mobile` (Expo).

`contract` is its own package because the clients may not import server internals, and putting the schemas in `client` would make the API depend on a client package.

Every provider method takes an `AbortSignal` and none reads the environment:

```ts
interface ChatProvider {
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
}
interface SearchProvider {
  search(q: { query: string; limit: number }, signal: AbortSignal): Promise<SearchResult[]>;
}
interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], signal: AbortSignal): Promise<Float32Array[]>;
}
interface ModerationProvider {
  classify(input: ModerationInput, signal: AbortSignal): Promise<ModerationVerdict>;
}
```

Tool-call arguments stay `unknown` until each tool's Zod schema parses them.

**Guard boundary, enforced three ways:**

1. **Composition root.** Only `apps/api/src/compose.ts` (and the eval runner, a second composition root) imports `packages/providers`. It builds `createAssistant(deps)`, which exposes `handleTurn(input, signal): AsyncIterable<SseEvent>`. Routes see nothing else.
2. **Branded types.** `ModeratedText` is declared in `core` and minted in exactly one place, `guardrails/src/mint.ts`, which the pipeline calls after a pass. A type-aware ESLint rule (`eslint-rules/no-brand-cast.js`) forbids code that asserts a branded type without producing one (casts, type arguments, type predicates, bodiless signatures and ambient declarations) and casts that contain `never` or a type parameter, everywhere except the mint files. A comment that disables it is itself an error. It is a tripwire, not a proof, so the route-inventory test below carries the end-to-end guarantee. Likewise `UntrustedWebText` is minted only by the wrapping function in `tools` ([ADR-0008](0008-fetch-safety.md)), and prompt assembly accepts web content only as `UntrustedWebText`, so page text cannot reach a prompt unwrapped. `ConversationRepo.append`, `MemoryRepo.add`, `FeedbackRepo.add` and the agent's user-message slot accept only `ModeratedText`. The search cache is the one store that holds unmoderated text by design (public web results, wrapped as untrusted on every read), and it takes plain strings.
3. **Checks:** dependency-cruiser rules `providers-only-from-compose` (from anything matching `pathNot: ['^apps/api/src/compose\.ts$', '^packages/providers/', '^packages/eval/', '\.test\.tsx?$']` to `^packages/providers/`; the eval runner is a second composition root that wires mock and real providers, and tests may use the mock providers), `storage-not-from-routes` (from `^apps/api/src/routes/` to `^packages/storage/`) and `tools-not-to-storage`; plus a route-inventory test that registers every POST route with a mock moderator that flags everything and asserts the mock chat provider was called zero times.

A rule restricting chat-provider imports by module path was proposed and dropped: dependency-cruiser sees files, not interfaces, so the brand and the route-inventory test carry that guarantee instead.

Wiring is a manual composition root of about 60 lines. Tests call `createAssistant` and `createApp` with fakes.

## Consequences

- Passing unmoderated text to a store or the agent fails the typecheck, the common ways of hiding it fail lint, and a new route that reaches the model fails a test.
- Nine `package.json` files to maintain. The per-package config is small and identical.
- I revisit the container decision at around 30 injectables with lifetimes.

## Evidence

- The existing `clients-not-to-server-internals` rule in `.dependency-cruiser.cjs` already forbids `packages/client` from importing `core`, which is why `contract` is separate.
- Grok post-mortem coverage: https://techcrunch.com/2025/07/12/xai-and-grok-apologize-for-horrific-behavior (accessed 2026-11-12).
