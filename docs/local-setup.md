# Local setup

Everything runs on one Mac. I use an M1 Pro with 16 GB of RAM.

## Prerequisites

- Node.js 24 (`.nvmrc` pins the major version; `nvm use` picks it up)
- Docker Desktop, for SearXNG
- Ollama 0.40.15 or newer

## Ollama and models

I pick the chat model by RAM. Check yours with:

```bash
sysctl -n hw.memsize | awk '{ printf "%.0f GB\n", $1 / 1024 / 1024 / 1024 }'
```

With about 16 GB or more I use `qwen2.5:7b`. With less, use `llama3.2:3b`.

```bash
ollama pull qwen2.5:7b
```

On 16 GB I use the 1B guard, because the 8B guard cannot stay loaded next to the chat model ([ADR-0006](adr/0006-guard-model-size.md)). With 24 GB or more, pull `llama-guard3:8b` instead.

```bash
ollama pull llama-guard3:1b
```

```bash
ollama pull nomic-embed-text
```

The database lives in `data/`. Exclude that folder from Time Machine, or deleted conversations survive in backups.

## Ollama settings

The guard and the chat model must stay loaded together, and Ollama should run one request at a time ([ADR-0006](adr/0006-guard-model-size.md), [ADR-0011](adr/0011-search-cache-and-rate-limits.md)). The API asks for a 30-minute `keep_alive` on every call. Set parallelism for the Ollama app, then quit and reopen it:

```bash
launchctl setenv OLLAMA_NUM_PARALLEL 1
```

The doctor script that arrives with `npm run dev` checks the Ollama version, the pulled models and their digests.

## SearXNG

SearXNG runs in Docker Compose and needs no API key. The Compose file and settings arrive in Milestone 4, and this section will cover starting it and checking that it answers.

## Running the assistant

`npm run dev` arrives in Milestone 2.

## Mobile app with Expo Go

The Expo app arrives in Milestone 6, and this section will cover running it on a phone with Expo Go on the same Wi-Fi network.
