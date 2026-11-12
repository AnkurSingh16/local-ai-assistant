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

`npm run doctor` (run automatically before `npm run dev`) checks the Ollama version, that the configured models are pulled, and that their digests match the ones pinned in ADR-0010. It also checks that ports 8787 and 5173 are free. Every failure comes with the command that fixes it.

## SearXNG

SearXNG runs in Docker Compose and needs no API key. The Compose file and settings arrive in Milestone 4, and this section will cover starting it and checking that it answers.

## Running the assistant

```bash
npm run dev
```

This runs the doctor, then starts the API on `http://127.0.0.1:8787` and the web app on `http://127.0.0.1:5173`. Open the web app in a browser. The web dev server proxies `/v1` to the API, so the browser only ever talks to one origin. Both bind to loopback only.

The first answer after a restart takes longer while Ollama loads the models. The API loads the guard model at startup, and `GET /readyz` turns ready once it answers.

To try the app without Ollama, run the mock providers. Answers are a fixed sentence, and messages containing `MOCK_FLAG` are refused:

```bash
PROVIDERS=mock npm run dev -w @local-ai/api
```

If port 5173 is taken by another project's dev server, the doctor says so. Stop that server first; the web app does not move to another port silently.

## Mobile app with Expo Go

The Expo app arrives in Milestone 6, and this section will cover running it on a phone with Expo Go on the same Wi-Fi network.
