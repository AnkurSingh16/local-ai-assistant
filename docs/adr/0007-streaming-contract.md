# ADR-0007: Streaming contract: POST with Server-Sent Events read through fetch

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Ankur Pawar

## Context

The web app and the Expo app share one headless client. Answers stream paragraph by paragraph, with status, citations, refusals and errors. React Native has no `EventSource`, and `EventSource` cannot send a body or headers.

## Options considered

1. **GET with `EventSource`**, after a POST that creates the turn. Two requests, and no native support on React Native.
2. **WebSocket.** Bidirectional, but more protocol and an extra library on mobile for no gain.
3. **POST with a JSON body, answered as `text/event-stream`, read with `fetch` and a stream parser.**

## Decision

Option 3. `POST /v1/chat` returns `text/event-stream`. `packages/contract` defines the events as a Zod discriminated union, and `packages/client` parses them from `response.body`:

| Event      | Payload                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `meta`     | `conversationId`, `messageId`                                                                                             |
| `status`   | `phase`: `moderating`, `searching`, `reading`, `answering`; optional `detail` (the search query or the domain being read) |
| `delta`    | `text` of a released paragraph                                                                                            |
| `citation` | `n`, `url`, `title`                                                                                                       |
| `refusal`  | `kind`: `policy`, `self_harm`, `unavailable`, `rate_limited`; fixed `message`                                             |
| `error`    | `code`, generic `message`, `requestId`, `retryable`                                                                       |
| `done`     | `finishReason`                                                                                                            |

- Each event carries `id: <messageId>:<seq>`. A `: ping` comment every 15 s keeps proxies from closing the stream. There is no resume in v1; the client retries the whole turn.
- Errors never include stack traces, model names or provider messages.
- **Cancellation:** the client aborts its `AbortController`; the server ties the request's `close` event to the turn's signal, which stops Ollama generation.
- **CSRF and CORS:** requests must be `Content-Type: application/json` (a form post gets 415), cookie-authenticated requests must carry an allowed `Origin`, and CORS uses an allowlist, never `*` with credentials. The `Origin` check matters locally because browsers treat every `localhost` port as the same site, so `SameSite=Strict` alone does not stop another local dev server.

## Consequences

- One request per turn, the same parser on web and mobile, and contract tests that run the same fixtures through both clients.
- No mid-stream resume on flaky mobile networks. If that becomes a problem, events can be replayed from storage by sequence number.

## Evidence

- `expo/fetch` streams `response.body` and, in its source, honours `AbortSignal` (the docs do not say so); a device test in Milestone 6 confirms it: https://docs.expo.dev/versions/latest/sdk/expo/ (accessed 2026-11-12).
