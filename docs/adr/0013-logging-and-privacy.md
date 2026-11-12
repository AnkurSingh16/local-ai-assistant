# ADR-0013: Logging without message text

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Ankur Pawar

## Context

Logs are needed to debug latency, failures and guard decisions, but they must not contain what users wrote, what the model said, page content or personal data.

## Options considered

1. **Log request bodies and rely on pino `redact`.** Easy, but any new field or nested path leaks until someone adds a redaction rule.
2. **A typed logging helper whose event types have no free-text fields, with pino `redact` as a backstop.**

## Decision

Option 2.

- The API logs through `logEvent(event)`, where every event type is a closed, typed shape: request id, hashed session id, route, status, latency, token counts, tool names, fetched domains (never full URLs, which can carry queries), guard decision and refusal kind, error code.
- pino `redact` removes `req.body`, `req.query`, `*.text`, `*.content`, `*.message`, `*.prompt` and the `authorization` and `cookie` headers as a backstop.
- Level `info` by default, JSON to stdout, `pino-pretty` only in development.
- A debug flag that logs content exists only for local development, is off by default, refuses to start when `NODE_ENV=production`, and prints a warning on every start.

## Consequences

- Debugging a bad answer needs a local reproduction, not a log search. I accept that.
- A test plants a unique marker in every input field, runs a full turn (including a refusal and an error), captures every log line and asserts none contains the marker.

## Evidence

- The logging rule is a fixed requirement ([requirements](../architecture/requirements.md)); OWASP LLM02:2025 lists logs as a disclosure channel: https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/ (accessed 2026-11-12).
