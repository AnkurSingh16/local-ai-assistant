# Taking it to production

This is how I would take the assistant from my Mac to a public service. Every price and limit carries the date I checked it. Prices change often, so check the linked page before relying on a number.

The design already allows this move. Chat, search, embeddings and moderation sit behind provider interfaces, and only `apps/api/src/compose.ts` picks the implementations (ADR-0002). Moving to hosted services means new providers and configuration, not a new agent or new guards.

## 1. Hosted chat models

Prices are per million tokens, for standard (not batch) requests, checked on 2026-11-13.

| Provider and model                                     | Input  | Output | Notes                                  |
| ------------------------------------------------------ | ------ | ------ | -------------------------------------- |
| Anthropic Claude Haiku 5.5 (prompts up to 100k tokens) | $0.10  | $0.50  | Cache hits $0.01; Batch API half price |
| Anthropic Claude Sonnet 5.5                            | $2.00  | $10.00 | Cache hits $0.10                       |
| Anthropic Claude Opus 5.5                              | $4.00  | $20.00 |                                        |
| OpenAI gpt-6-luna                                      | $0.10  | $0.50  | Cached input $0.01; Batch half price   |
| OpenAI gpt-6.1-terra                                   | $1.00  | $5.00  |                                        |
| OpenAI gpt-6-astra                                     | $10.00 | $50.00 |                                        |
| Google Gemini 3.1 Flash-Lite                           | $0.25  | $1.50  | Free tier available                    |
| Google Gemini 3.8 Flash                                | $0.75  | $3.75  | Rises to $1.50 / $7.50 on 2027-01-01   |
| Google Gemini 3.1 Pro Preview                          | $2.00  | $12.00 | Not on the free tier                   |
| Together AI, Qwen2.5 7B Instruct Turbo                 | $0.30  | $0.30  | The same model family I run locally    |

Sources: [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Gemini pricing](https://aistudio.google.com/docs/pricing), [Together AI pricing](https://www.together.ai/pricing), all accessed 2026-11-13.

**Data use.**

- Anthropic's commercial terms say it "may not train models on Customer Content from Services" ([commercial terms](https://www.anthropic.com/legal/commercial-terms), effective 2025-06-17, accessed 2026-11-13).
- OpenAI does not use API data for training unless the customer opts in, and keeps abuse-monitoring logs for up to 30 days ([your data](https://developers.openai.com/api/docs/guides/your-data), accessed 2026-11-13).
- Google's pricing page says free-tier data for Flash and Flash-Lite is used to improve its products. That rules the free tier out for real users' messages; the same page says paid-tier data is not used to improve its products.

**What I would choose.** The small tier of a hosted family: Claude Haiku 5.5 or gpt-6-luna. Either costs under a dollar per thousand turns (see the estimate below), and I expect either to answer far better than a 7B model on a laptop, but that is what the measurements must show. I would not pick between them from price tables. My eval runner already swaps providers (`packages/eval`), so I would record the red-team set and a small answer-quality set against both and choose on:

1. Zero harmful releases.
2. Fewest benign refusals.
3. Answers that cite the search results rather than stale knowledge, which `qwen2.5:7b` often fails to do (see the [safety guide](guides/safety.md)).

The other would be the fallback, behind the existing circuit-breaker pattern. A bigger model (Sonnet 5.5, gpt-6.1-terra) is worth paying for only if those measurements show the small one failing users.

## 2. Search for fresh information

| Option                                          | Price                                                   | Free allowance                                          | Checked    |
| ----------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- | ---------- |
| Brave Search API                                | $5 per 1,000 requests                                   | $5 of credit a month (the page also mentions up to $20) | 2026-11-13 |
| Tavily                                          | $0.008 per credit, or $30/month for 4,000 credits       | 1,000 credits a month                                   | 2026-11-13 |
| Claude web search tool                          | $10 per 1,000 searches, plus result tokens              | none                                                    | 2026-11-13 |
| OpenAI web search tool                          | $10 per 1,000 calls, plus content tokens                | none                                                    | 2026-11-13 |
| Gemini grounding with Google Search (Gemini 3+) | $14 per 1,000 after the free allowance; 1,500 a day cap | 5,000 a month                                           | 2026-11-13 |
| Self-hosted SearXNG                             | server cost only                                        | n/a                                                     | 2026-11-13 |

Sources: [Brave Search API](https://brave.com/search/api/), [Tavily pricing](https://tavily.com/pricing), [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Gemini pricing](https://aistudio.google.com/docs/pricing), accessed 2026-11-13.

SearXNG is right for one person on one machine, but a public deployment would hit the problem its own docs describe: upstream engines may answer with a CAPTCHA or block the instance ([SearXNG limiter](https://docs.searxng.org/admin/searx.limiter.html), accessed 2026-11-13). For production I would use **Brave Search API** behind the existing `SearchProvider` interface. It costs half as much per query as the model providers' built-in tools. More importantly, results come back as data, so my wrapper, taint rule, query personal-data check and citation filter keep working exactly as they do today. With a provider's built-in search tool, the provider fetches and injects results itself, outside those controls. I would accept that only with a separate review of what the provider does with result text.

## 3. Moderation

| Option                                          | Price                              | Checked    |
| ----------------------------------------------- | ---------------------------------- | ---------- |
| OpenAI `omni-moderation-latest`                 | free                               | 2026-11-13 |
| Llama Guard 4 12B on DeepInfra (via OpenRouter) | $0.144 to $0.27 per million tokens | 2026-11-13 |
| `llama-guard3` self-hosted (today)              | server cost only                   | n/a        |

Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [OpenRouter: Llama Guard 4 12B](https://openrouter.ai/meta-llama/llama-guard-4-12b), accessed 2026-11-13.

I would keep the layered design: the rules baseline first (it caught the direct self-harm messages and the three warning-sign messages the 1B guard missed; two messages phrased so that no rule matches got crisis lines only because the persona tells the model to include them), then a classifier, then the output rules on every paragraph. For the classifier I would measure both candidates on the red-team set. Llama Guard 4 keeps the same hazard taxonomy my refusal mapping uses, so it is a drop-in `ModerationProvider`. The OpenAI endpoint is free but uses its own categories, so it needs a new mapping. Either way the 1B model's false positives (6 of 31 benign look-alikes in the last run) should drop, and the measured numbers go in the safety guide as they do today.

## 4. Making the assistant better over time

In order of cost:

1. **Persona and prompt tuning.** Free, and versioned in `packages/agent/persona/`. Every change triggers a red-team re-record, so a regression shows in the PR.
2. **Better routing and retrieval.** A routing eval (questions labelled "needs search" or not) to measure the pre-router's recall, which I deliberately make no claim about today. Then curated sources for topics people actually ask about.
3. **Preference data from approved feedback.** The review queue (`npm run review`) already turns feedback into approved memory and anonymised eval cases. At scale, approved corrections become a preference dataset.
4. **Fine-tuning.** Last, and only for tone, format or refusal calibration. A fine-tuned model still knows nothing about events after its training data; fresh facts come from search, which is why search, citations and the taint rule are the core of the design. Together AI lists supervised fine-tuning of Llama 3.1 8B from $0.34 per million training tokens, minimum $4 ([Together AI pricing](https://www.together.ai/pricing), accessed 2026-11-13). Nothing learned from users is used until I approve it (ADR-0009), at any scale.

## 5. Deployment

**Shape.** The same Fastify API and built web app in containers, with hosted search instead of SearXNG. No GPU is needed once the models are hosted. The changes:

- **Database.** Swap SQLite for managed Postgres behind the existing repositories (ADR-0001 records this as the scaling path). Keep the deletion guarantees: cascades from the session, and no copy of deleted text in backups beyond their retention window, stated on the memory page.
- **Rate limits and caching.** Move both from process memory to Redis or Valkey, so several API instances share them, including the per-session chat limit that today lives in process memory (`createWindowLimiter` in `apps/api/src/limits.ts`).
- **Edge.** TLS and the Host allowlist at a reverse proxy; the API never binds to the internet directly (ADR-0010).
- **Secrets.** Provider keys in the host's secret store, never in the image or the repository. CI stays key-free: it replays recorded outputs (ADR-0012).
- **Observability.** The existing pino events (no message text) to a log service; alerts on guard timeouts, breaker trips, refusal-rate shifts and provider errors.
- **CI/CD.** The current workflows plus an image build and a deploy on merge to `main`.

**Hosting prices checked on 2026-11-13:**

- Fly.io: shared-cpu-1x with 1 GB is $6.70/month, shared-cpu-2x with 2 GB is $13.39/month, and volumes are $0.15 per GB-month ([Fly.io pricing](https://docs.fly.io/about/pricing)).
- Neon Postgres: a free plan with 1 GB of storage per project and 100 CU-hours a month. The Launch plan is $0.106 per CU-hour and $0.35 per GB-month, and Neon estimates about $15/month for a small, intermittently used database ([Neon pricing](https://neon.com/pricing)).
- RunPod, if I kept self-hosted models: an L4 is $0.69/hour on Secure Cloud and an H100 SXM is $4.39/hour ([RunPod pricing](https://www.runpod.io/pricing)).

**Estimated monthly cost.** I assume 20 turns per user a month and 400 output tokens per turn. A turn without search is one model call of about 3,000 input tokens (persona, history, memory). A turn with search, 30% of turns, makes up to four calls, and each resends the prompt plus the snippets or pages read so far; I count it as about 12,000 input tokens in all. That averages about 5,700 input tokens a turn. Classifier calls are about 2,500 tokens a turn, for the input and each paragraph.

| Item                                                               | Small demo (100 users, 2,000 turns) | 10,000 users (200,000 turns)                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Chat, Claude Haiku 5.5 or gpt-6-luna                               | about $2                            | about $150 to $200 (1.1B input, 80M output tokens)                                                                               |
| Search, Brave (600 / 60,000 queries)                               | $0 within free credit               | about $300                                                                                                                       |
| Moderation, Llama Guard 4 at $0.18/M (or the free OpenAI endpoint) | under $1                            | about $90 (or $0)                                                                                                                |
| API hosting, Fly.io                                                | $13 (one shared-cpu-2x)             | about $70 (two to four machines plus a small managed Redis or Valkey; the Redis share is my rough allowance, not a quoted price) |
| Postgres, Neon                                                     | $0 (free plan)                      | about $15 to $50                                                                                                                 |
| **Total**                                                          | **about $15**                       | **about $600 to $700**                                                                                                           |

These are estimates from list prices, not measurements. The biggest swing is the model tier: the same 10,000 users on Claude Sonnet 5.5 would cost about $3,000 for chat alone. Prompt caching of the persona would cut input costs. Self-hosting instead, one always-on L4 at $0.69/hour is about $500/month before redundancy: two to three times the hosted small models' chat and moderation tokens at this volume, and I expect it to answer worse.

## 6. Production readiness checklist

- [ ] Hosted chat, search and moderation providers chosen by recorded red-team and answer-quality runs, with numbers in the safety guide
- [ ] Red-team set re-recorded against the production providers; zero harmful releases
- [ ] Postgres repositories, with the deletion test (raw files checked) rewritten for Postgres and backups
- [ ] Per-IP and per-session rate limits and the search cache moved to Redis or Valkey
- [ ] TLS reverse proxy, Host allowlist and CORS set for the public origin only
- [ ] Secrets in the host's secret store; key rotation documented
- [ ] Logs with no message text shipped to a log service; alerts on guard timeouts, breaker state, refusal rate and provider errors
- [ ] Terms of use and a privacy notice that match ADR-0009 (what is stored, review, deletion, search disclosure)
- [ ] Abuse limits sized for the public: per-IP session creation, per-session turns, request size
- [ ] Load test of streaming under the expected peak, with the turn timeout and the client's idle timeout confirmed
- [ ] The mobile Stop check from `apps/mobile/README.md` recorded on a physical device
- [ ] Incident runbook: disabling search, forcing the fallback model, and rotating keys
