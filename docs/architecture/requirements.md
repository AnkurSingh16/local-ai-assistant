# Requirements

These are the requirements I set for this project. Anything marked fixed changes only through an ADR backed by evidence.

## Goal

A general-purpose assistant that answers from the model's own knowledge and from current web information, like ChatGPT or Gemini, but runs entirely on my Mac at no cost.

## Fixed decisions

- **Stack:** Node.js 24, TypeScript strict, npm workspaces. Fastify API, React 19 + Vite web client, React Native + Expo mobile client. Vitest, React Testing Library, React Native Testing Library, Playwright. Zod for validation, pino for logging. No other application languages. Infrastructure may run in Docker.
- **Models (Ollama):** chat model chosen by RAM (16 GB or more: `qwen2.5:7b` or `llama3.1:8b`; less: `llama3.2:3b`); safety classifier `llama-guard3`; embeddings `nomic-embed-text` through Ollama or transformers.js. Everything behind provider interfaces so hosted APIs can be added.
- **Fresh information:** self-hosted SearXNG in Docker Compose, no API key. Result pages fetched with `@mozilla/readability` + `jsdom`, with size limits, timeouts, https only, and SSRF protection that refuses private, loopback, link-local and reserved addresses and re-checks every redirect.
- **Storage:** SQLite or PostgreSQL for conversations, memory, feedback and a search-result cache. I chose SQLite in [ADR-0001](../adr/0001-storage-sqlite.md).
- **Tests and CI:** mock providers for chat, search, embeddings and moderation by default. CI never calls Ollama, SearXNG or the internet.

## Behaviour

- An agent loop with tools (`web_search`, `read_page`, `get_current_datetime`) decides each turn whether to answer from knowledge or search. Recent events, prices, scores, releases, people's current roles and anything time-sensitive go through search. Steps are bounded, with timeouts and cancellation.
- Facts from the web are cited with numbered links. Fetched pages are untrusted data: wrapped, never followed as instructions, and tested against prompt injection.
- A natural tone from a configurable persona and style guide; streaming over SSE; conversation memory; follow-ups understood in context.
- A web app and an Expo app share a headless TypeScript client package that parses SSE from `fetch`.

## Guardrails (top priority)

1. **Input moderation** before any model call, with `llama-guard3` plus a rules baseline, covering hate and harassment (including slurs), sexual content (and anything involving minors), violence, self-harm (answered with care and crisis resources), extremism, abusive language, illegal activity and personal data. Flagged input gets a calm refusal and is never sent to the chat model or stored as text.
2. **Output moderation** on every streamed paragraph before release. The assistant never insults the user, never gives personal political opinions (contested topics get balanced, factual overviews), never claims feelings it does not have, and never pretends to be human. The persona stays stable.
3. **Jailbreak and injection resistance:** detection of role-play overrides, "ignore previous instructions", system-prompt extraction and encoded instructions; web content treated as untrusted; a red-team eval set of at least 100 prompts that runs in CI with mock and rules providers and locally with `llama-guard3`. A harmful output fails the build.
4. **Safe learning:** the assistant never updates itself from raw conversations. Feedback, corrections and remembered preferences are moderated before storage; flagged items are dropped. A review command lists candidates, and only items I approve become memory, eval cases or fine-tuning examples. Users can view and delete what is remembered about them.
5. **Abuse and cost limits:** rate limits per session and per IP, size limits, and logs without message text by default.

## Engineering standards

- Strict TypeScript with no `any`, ESLint strict type-checked rules, Prettier, dependency-cruiser boundaries, and dependency injection for providers and clocks. Comments explain why.
- Tests cover every tool and guard, agent routing decisions, SSRF and redirect checks, the injection and red-team suites, streaming contracts for both clients, and memory deletion. Line coverage stays at or above 85%.
- Issues and milestones, feature branches, Conventional Commits, small squash-merged PRs from a template, branch protection.
- Workflows: CI, end-to-end tests, the red-team eval, security scanning, PR title check and Dependabot. No workflow needs a paid API key.
