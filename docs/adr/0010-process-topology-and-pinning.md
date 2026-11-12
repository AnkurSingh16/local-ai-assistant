# ADR-0010: Process topology, network binding and version pinning

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Ankur Pawar

## Context

Ollama has no authentication and has had serious vulnerabilities; SearXNG is an open search proxy. Both must stay unreachable from the network. Development should start with one command, and eval results only mean something if I know exactly which models produced them.

## Options considered

1. **Everything in Docker Compose.** Uniform, but Docker on a Mac has no GPU access for Ollama, and an API container slows the edit-reload loop.
2. **Only SearXNG in Docker; Ollama and the API native on the host.**

## Decision

Option 2.

- **Ollama** runs natively for Metal acceleration, on its default `127.0.0.1:11434`. `OLLAMA_HOST=0.0.0.0` is never set. Minimum version: 0.40.15, the version I tested.
- **SearXNG** runs in Docker Compose, published only as `127.0.0.1:8888:8080`, with a read-only filesystem, `cap_drop: [ALL]`, `no-new-privileges`, the image pinned by digest (kept current by Dependabot if its Docker Compose support covers digest pins, otherwise by a scheduled workflow; verified in Milestone 4), a random `secret_key`, JSON output enabled and its limiter off while it is reachable only from loopback.
- **The API** binds `127.0.0.1` by default. `npm run dev:mobile` sets `HOST=0.0.0.0` so a phone on the same Wi-Fi can reach it, and the API logs a warning when bound beyond loopback. A public demo puts a TLS-terminating proxy or tunnel in front of the API only.
- **`npm run dev`** starts SearXNG with `docker compose up -d --wait`, then the API (`tsx watch` with the `@local-ai/source` condition) and the web app with `concurrently`. A `predev` doctor script checks the Ollama version, that the configured models are pulled, and that SearXNG answers, and prints the exact fix when something is missing. The Expo app has its own `npm run dev:mobile`, because Expo's interactive terminal does not mix with `concurrently`.
- **Configuration** is one Zod schema in `apps/api/src/config.ts` over environment variables, with defaults for everything. Node's `--env-file-if-exists=.env` replaces dotenv; `.env.example` documents the variables.
- **Pinned model digests** (from `ollama list` on 2026-11-12) are recorded in configuration, checked by the doctor script, and printed in every eval report: `qwen2.5:7b` 845dbda0ea48, `llama-guard3:1b` 494147e06bf9, `llama-guard3:8b` 46f211c3d866. `nomic-embed-text` 0a109f422b47 (pulled 2026-11-12), added to configuration and the doctor when Milestone 5 uses it.

## Consequences

- Nothing listens beyond loopback unless I opt in. A CI check asserts every Compose `ports` entry starts with `127.0.0.1:` and the API's default host is loopback. No test probes the network from CI.
- Developers need Docker Desktop and Ollama installed locally; the doctor script makes the failure obvious.
- A shared or hosted deployment would containerise the API; [production.md](../production.md) covers it.

## Evidence

- Ollama CVE-2024-37032 ("Probllama"), exploitable when Ollama is exposed: https://www.wiz.io/blog/probllama-ollama-vulnerability-cve-2024-37032 (accessed 2026-11-12).
- Docker publishes ports on all interfaces unless an address is given (Compose `ports` short syntax), which is why every entry names `127.0.0.1`.
