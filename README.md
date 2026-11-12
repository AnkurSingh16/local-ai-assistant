# local-ai-assistant

A general-purpose AI assistant that runs entirely on my Mac and costs nothing to run. It answers from the model's own knowledge, or searches the web when a question needs current information, and cites what it found with numbered links. It sits behind layered guardrails that I measure with a red-team eval.

It is a demo project, separate from my retrieval-only portfolio chatbot.

## Honest expectations

- A 7B model running locally is far less capable than ChatGPT or Gemini. Expect weaker reasoning, more mistakes and shorter useful answers.
- Search makes it current, but the quality of an answer depends on the model and on what the search returns.
- Every eval number in this repository is reported exactly as measured, with the date and the command.

## Status

| Milestone | Scope                                               | State       |
| --------- | --------------------------------------------------- | ----------- |
| 0         | Repository, tooling, CI, docs skeleton              | In progress |
| 1         | Architecture debate and ADRs                        | Planned     |
| 2         | Chat with Ollama, streaming API, minimal web client | Planned     |
| 3         | Guardrails and the red-team eval in CI              | Planned     |
| 4         | Web search with SearXNG, SSRF protection, citations | Planned     |
| 5         | Memory, feedback and safe learning                  | Planned     |
| 6         | Polished web client and Expo mobile app             | Planned     |
| 7         | Production write-up and final audit                 | Planned     |

## Architecture

This is the target design. Component boundaries are confirmed in the ADRs in [`docs/adr/`](docs/adr/).

```mermaid
flowchart LR
  subgraph Clients
    W[Web app<br/>React 19 + Vite]
    M[Mobile app<br/>Expo]
    C[Client package<br/>SSE over fetch]
    W --> C
    M --> C
  end

  subgraph API[Fastify API]
    RL[Rate and size limits]
    IM[Input moderation<br/>rules + llama-guard3]
    AG[Agent loop<br/>bounded steps, timeouts]
    OM[Output moderation<br/>per paragraph]
    RL --> IM --> AG --> OM
  end

  subgraph Tools
    WS[web_search]
    RP[read_page<br/>SSRF-safe fetch]
    DT[get_current_datetime]
  end

  C -- HTTPS + SSE --> RL
  AG --> WS & RP & DT
  AG -- chat --> OL[(Ollama<br/>qwen2.5:7b)]
  IM & OM -- classify --> OL
  WS --> SX[(SearXNG<br/>Docker)]
  RP --> NET[(Public web)]
  AG <--> DB[(Storage<br/>conversations, memory,<br/>feedback, search cache)]
  OM -- SSE stream --> C
```

## Quick start

What works today is the toolchain:

```bash
git clone https://github.com/AnkurSingh16/local-ai-assistant.git
```

```bash
cd local-ai-assistant && npm ci
```

```bash
npm run check
```

The five-minute quick start for the running assistant (`npm run dev` with Ollama and SearXNG) arrives with Milestone 2 and is completed in Milestone 4. [`docs/local-setup.md`](docs/local-setup.md) covers installing Ollama and pulling the models now.

## Documentation

- [Requirements](docs/architecture/requirements.md) and [architecture](docs/architecture/README.md)
- [Architecture decision records](docs/adr/README.md)
- [Local setup](docs/local-setup.md)
- [Safety guide](docs/guides/safety.md)
- [Development](docs/development/README.md)
- [Configuration](docs/reference/configuration.md) and [API](docs/reference/api.md) reference
- [Taking it to production](docs/production.md)

## License

[MIT](LICENSE)
