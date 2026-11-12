# Safety guide

Safety is the top priority in this project. I am designing the guardrails around what went wrong with Microsoft's Tay (learning directly from abusive users), early Bing Chat (persona drift and hostility under pressure) and Grok (offensive output reaching users). No single layer is trusted on its own.

## Layers

| Layer                         | What it does                                                               | Milestone |
| ----------------------------- | -------------------------------------------------------------------------- | --------- |
| Abuse and cost limits         | Per-session and per-IP rate limits, size limits, logs without message text | 2–3       |
| Input moderation              | Rules baseline plus `llama-guard3` before any model call                   | 3         |
| Jailbreak and injection guard | Detects overrides, prompt extraction and encoded instructions              | 3         |
| Persona stability             | A fixed persona the user cannot replace                                    | 3         |
| Output moderation             | Checks every streamed paragraph before release                             | 3         |
| Untrusted web content         | Fetched pages wrapped as data, never followed as instructions              | 4         |
| Safe learning                 | Feedback moderated before storage; only items I approve are used           | 5         |

## What runs today

Milestone 2 ships the first part of these layers, so no answer is ever unmoderated:

- Per-IP rate limits, a 16 KB body limit, 4,000 characters per message, and a cap of two concurrent turns with a queue of four.
- Normalisation (NFKC; zero-width, bidi and tag characters stripped; chat-template tokens neutralised) before anything is checked.
- `llama-guard3` on every user message and on every paragraph of the answer before it is sent. If the guard errors, times out or answers in an unexpected format, the turn is refused with `unavailable`; there is no fail-open setting. A check gets 2 seconds when Ollama reports the guard model loaded and 20 seconds when it may need a load. After 5 failed checks in a row a circuit breaker refuses every check with `unavailable` for 10 seconds, then lets one probe through.
- Fixed refusal texts that name no rule. Self-harm gets crisis resources instead of a refusal, without calling the chat model.
- A persona in code (`packages/agent/persona/persona.ts`) that says the assistant is an AI, has no feelings and gives no political opinions.
- Typed log events with no field for message text, and a test that checks a marker string never reaches the logs.

Coming in Milestone 3:

- the rules baseline and jailbreak detection;
- persona output rules;
- the red-team set.

## Measured results

Not measured yet. The red-team eval lands in Milestone 3, and I will report results here exactly as measured, with the date, the providers used and the command.
