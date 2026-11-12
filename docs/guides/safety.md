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

## Measured results

Not measured yet. The red-team eval lands in Milestone 3, and I will report results here exactly as measured, with the date, the providers used and the command.
