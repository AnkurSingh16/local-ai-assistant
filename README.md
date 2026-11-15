# local-ai-assistant

A general-purpose AI assistant that runs entirely on my Mac and costs nothing to run. It answers from the model's own knowledge, or searches the web when a question needs current information, and cites what it found with numbered links. It sits behind layered guardrails that I measure with a red-team eval.

It is a demo project, separate from my retrieval-only portfolio chatbot.

## Honest expectations

- A 7B model running locally is far less capable than ChatGPT or Gemini. Expect weaker reasoning, more mistakes and shorter useful answers.
- Search makes it current, but the quality of an answer depends on the model and on what the search returns.
- Every eval number in this repository is reported exactly as measured, with the date and the command.

## Limitations

These are the limits I hit most often. The full list of open gaps, with how each was measured, is in the [audit](docs/architecture/audit.md#open-gaps).

- **Answers sometimes stop halfway.** The small safety model (`llama-guard3:1b`) checks every paragraph of an answer, and it still flags some harmless ones. When it does, the answer ends with "I can't help with that." On my eval set of answer paragraphs it withheld 18 of 243 harmless ones, and in live use 3 of 20 answers to "What is the latest version of Node.js?" were cut off ([ADR-0014](docs/adr/0014-output-guard-stand-in.md)). The fix is a better guard model, and the 8B one cannot stay loaded next to the chat model on 16 GB.
- **Some questions that need fresh information are answered without a search.** Deciding whether to search is done by rules, and they catch 70% to 77% of the questions that need the web, against a 95% target. So between one in four and one in three such questions get an answer from the model's own knowledge, which may be out of date. More rules overfit, and asking `qwen2.5:7b` to decide did not help, so closing the gap needs a stronger model.
- **Answers that search the web are slow.** The model has to read the fetched pages before it writes, and it writes at about 26 tokens a second on my M1 Pro, so a cited answer takes noticeably longer than one from the model's own knowledge. A cold load of the chat model adds about 5 seconds more ([ADR-0006](docs/adr/0006-guard-model-size.md)).

## Status

| Milestone | Scope                                               | State |
| --------- | --------------------------------------------------- | ----- |
| 0         | Repository, tooling, CI, docs skeleton              | Done  |
| 1         | Architecture debate and ADRs                        | Done  |
| 2         | Chat with Ollama, streaming API, minimal web client | Done  |
| 3         | Guardrails and the red-team eval in CI              | Done  |
| 4         | Web search with SearXNG, SSRF protection, citations | Done  |
| 5         | Memory, feedback and safe learning                  | Done  |
| 6         | Polished web client and Expo mobile app             | Done  |
| 7         | Production write-up and final audit                 | Done  |

## Architecture

This is the design I settled on in the [architecture decision records](docs/adr/README.md); [docs/architecture](docs/architecture/README.md) walks through a turn end to end.

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
    IM[Input moderation<br/>rules + llama-guard3:1b]
    AG[Agent loop<br/>bounded steps, timeouts]
    OM[Output moderation<br/>per paragraph]
    RL --> IM --> AG --> OM
  end

  subgraph Tools
    WS[web_search]
    RP[read_page<br/>SSRF-safe fetch,<br/>parse in a worker]
    DT[get_current_datetime]
  end

  C -- HTTPS + SSE --> RL
  AG --> WS & RP & DT
  AG -- chat --> OL[(Ollama<br/>qwen2.5:7b,<br/>llama-guard3:1b)]
  IM & OM -- classify --> OL
  WS --> SX[(SearXNG<br/>Docker)]
  RP --> NET[(Public web)]
  AG <--> DB[(SQLite<br/>conversations, memory,<br/>feedback, search cache)]
  OM -- SSE stream --> C
```

## Quick start

You need Node.js 24 and Ollama with `qwen2.5:7b` and `llama-guard3:1b` pulled ([local setup](docs/local-setup.md)).

```bash
git clone https://github.com/AnkurSingh16/local-ai-assistant.git
```

```bash
cd local-ai-assistant && npm ci
```

```bash
npm run dev
```

Then open http://127.0.0.1:5173. It answers from model knowledge, and searches the web through SearXNG for anything time-sensitive, citing sources with numbered links. Every message is checked by input rules (self-harm, slurs, abuse, sexual content involving minors, injection, personal data) and `llama-guard3` before the model sees it, and every paragraph of the answer is checked by persona rules and `llama-guard3` before it is sent; the red-team results are in the [safety guide](docs/guides/safety.md#measured-results).

## Documentation

- [Requirements](docs/architecture/requirements.md), the [requirements audit](docs/architecture/audit.md) and [architecture](docs/architecture/README.md)
- [Architecture decision records](docs/adr/README.md)
- [Local setup](docs/local-setup.md)
- [Safety guide](docs/guides/safety.md)
- [Development](docs/development/README.md)
- [Configuration](docs/reference/configuration.md) and [API](docs/reference/api.md) reference
- [Taking it to production](docs/production.md)

## License

[MIT](LICENSE)
