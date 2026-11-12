# ADR-0006: llama-guard3:1b as the guard on 16 GB machines

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Ankur Pawar

## Context

The guard runs on every user message and every output paragraph, so it must stay loaded next to the chat model. My Mac has 16 GB of unified memory, shared with macOS, Docker Desktop and a browser.

## Options considered

1. **`llama-guard3:8b`** for everything. The strongest classifier, with all categories S1 to S14.
2. **`llama-guard3:1b`** for everything. Smaller and faster, without S14 (code interpreter abuse).
3. **8b for input, rules only for output.** Breaks the requirement that every streamed paragraph is moderated.

## Decision

On machines with less than 24 GB I use `llama-guard3:1b` for input and output; at 24 GB or more, `llama-guard3:8b`. The tag is configuration (`GUARD_MODEL`), so it is still `llama-guard3`. Both the chat model and the guard use `keep_alive` of 30 minutes. The choice is gated: if 1b fails the local red-team run where 8b passes, the likely fix is 8b with the 3B chat model (`llama3.2:3b`), but the requirements reserve the 3B model for machines under 16 GB, so that switch needs a superseding ADR with the measured results. S14 does not apply, because the assistant has no code-execution tool.

## Consequences

- Guard checks are fast enough to moderate every paragraph without visible delay once loaded.
- 1b had one false positive in ten benign prompts in my spike ("how do I kill a Python process"). The red-team set includes benign look-alikes so the false-positive rate is measured, not guessed.
- Red-team results are reported per guard tag and model digest.

## Evidence

Measured on my M1 Pro, 16 GB, Ollama 0.40.15, with `qwen2.5:7b` loaded (`keep_alive` 30 minutes), 2026-11-12:

|                                          | 8b                                                                  | 1b                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Size reported by `ollama ps`             | 5.01 GB                                                             | 1.17 GB                                                                                                                  |
| Stays loaded with qwen (4.76 GB)         | No: every switch evicted the other model; reloads took 2.9 to 3.7 s | Yes in 3 of 3 cycles; one earlier run evicted qwen once (3.1 s reload)                                                   |
| Cold first call                          | 4,654 ms                                                            | 2,225 ms                                                                                                                 |
| Warm, short user message (median of 5)   | 114 ms                                                              | 26 ms                                                                                                                    |
| Warm, ~300-token paragraph (median of 5) | 103 ms                                                              | 26 ms                                                                                                                    |
| Check while qwen generates               | first call waited 16.5 s for a load (15.5 s of it loading)          | 50 to 400 ms in one run; in another run the first call took 12,038 ms. qwen slowed to 23.2 tokens/s (26.7 in the 8b run) |
| Categories                               | S1 to S14                                                           | S1 to S13                                                                                                                |
| 10 harmful prompts flagged               | 10                                                                  | 10                                                                                                                       |
| 10 benign prompts flagged                | 0                                                                   | 1                                                                                                                        |

Running 8b on CPU instead kept both loaded but took 5,954 ms per warm paragraph, which is unusable.

These residency runs used qwen at the default 4,096 context. I repeated them at 8,192 for issue #29 on 2026-11-12, with no other Ollama client connected and my usual apps open:

- `ollama ps` sizes: `qwen2.5:7b` at 8,192 context 4.99 GB, `llama-guard3:1b` at 2,048 1.17 GB, `nomic-embed-text` at 2,048 0.34 GB, all on the GPU.
- Ollama decided residency from free system memory, not GPU memory: every load decision in its log said `system_limited=true` while Metal still had 6 to 12 GiB free.
- Load sequence: the first chat call was a cold load (5.3 s). The first guard call (1.8 s) evicted the chat model, and the second chat call (4.0 s) evicted the guard. The second guard call (1.6 s) fitted alongside, and the 4 calls after it took about 0.00 s to load. A cold `nomic-embed-text` load (8.5 s) evicted nothing, and the 8 calls after it all loaded in 0.01 s or less.
- Ollama's log for the evicting guard load reads "predicted to exceed available memory" with the guard at 1.6 GiB against 1.7 GiB free (it keeps some headroom I have not traced). The evicting chat load was 4.8 GiB against 4.1 GiB free. The guard load that fitted saw 2.9 GiB free with the chat model already resident.

So in this run all three models fit together on 16 GB, but the guard's load needed roughly 3 GiB of system memory free with the chat model resident, and the first turns after a start can still pay a reload. The 12 s first call while qwen was generating is why [ADR-0005](0005-guardrail-pipeline.md) applies the short check timeout only when `/api/ps` shows the guard already resident, and why the API warms the guard at startup.

Model sizes: https://ollama.com/library/llama-guard3/tags (accessed 2026-11-12).
