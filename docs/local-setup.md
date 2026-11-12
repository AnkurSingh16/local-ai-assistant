# Local setup

Everything runs on one Mac. I use an M1 Pro with 16 GB of RAM.

## Prerequisites

- Node.js 24 (`.nvmrc` pins the major version; `nvm use` picks it up)
- Docker Desktop, for SearXNG
- Ollama

## Ollama and models

I pick the chat model by RAM. Check yours with:

```bash
sysctl -n hw.memsize | awk '{ printf "%.0f GB\n", $1 / 1024 / 1024 / 1024 }'
```

With about 16 GB or more I use `qwen2.5:7b`. With less, use `llama3.2:3b`.

```bash
ollama pull qwen2.5:7b
```

```bash
ollama pull llama-guard3
```

```bash
ollama pull nomic-embed-text
```

## SearXNG

SearXNG runs in Docker Compose and needs no API key. The Compose file and settings arrive in Milestone 4, and this section will cover starting it and checking that it answers.

## Running the assistant

`npm run dev` arrives in Milestone 2.

## Mobile app with Expo Go

The Expo app arrives in Milestone 6, and this section will cover running it on a phone with Expo Go on the same Wi-Fi network.
