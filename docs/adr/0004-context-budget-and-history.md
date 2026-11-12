# ADR-0004: Context budget and conversation history

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Ankur Pawar

## Context

Ollama defaults to a 4,096-token context, which is too small once history and search results are added. If a prompt does not fit, Ollama does not fail: I found that it silently drops content, and in one case it drops the system prompt, which carries the persona and safety instructions.

## Options considered

1. **Let Ollama truncate.** No code, but the persona can silently disappear.
2. **Summarise older history** with an extra model call. Keeps more context, but costs a call per turn, and a summary of a conversation that included web content can carry injected text forward.
3. **An app-side token budget with hard slots, trimming oldest history first.**

## Decision

Option 3. Every chat call uses `num_ctx` 8,192, search turn or not, so there is one budget and no per-call context change (which may force Ollama to reload the model; issue #29 measures it). Guard calls use a fixed `num_ctx` of 2,048. The agent assembles every prompt against this budget:

| Slot                           | Tokens |
| ------------------------------ | -----: |
| System prompt and persona      |  1,000 |
| Approved memory                |    400 |
| History (oldest dropped first) |  1,800 |
| Current user message           |  1,000 |
| Search snippets                |    600 |
| Page extracts (2 x 1,000)      |  2,000 |
| Output reserve                 |  1,200 |
| Overhead                       |    192 |

- Token counts are estimated conservatively from character counts: characters / 4 for prose and characters / 2 for URLs and code (measured on `qwen2.5:7b`: 5.03 and 2.35 characters per token), and the estimator is calibrated against `prompt_eval_count` from Ollama responses in a local test. The prompt is refused before it reaches Ollama if the estimate exceeds the budget, and the API logs a warning if `prompt_eval_count` ever exceeds it.
- History is trimmed, not summarised. History holds only user messages and the assistant's released answers with their citations; raw search results and page text are never kept in history.
- Approved memory goes in its own system message, labelled as data about the user, after the persona. It does not count as tainted, because only items the owner approved get there.
- Template control tokens are rewritten to a non-token form in every piece of non-system text, after Unicode normalisation: any `<|...|>` sequence (which covers Qwen's `<|im_start|>`, `<|im_end|>`, `<|endoftext|>` and Llama 3's `<|start_header_id|>`, `<|eot_id|>` and similar), and `<tool_call>` and `</tool_call>`.

## Consequences

- The persona can never be dropped by the runtime.
- Long conversations lose their oldest turns. That also limits persona drift in long sessions, which is what Microsoft found with early Bing Chat.
- Whether `qwen2.5:7b` at 8,192 context and `llama-guard3:1b` still stay loaded together is not yet measured (the residency results in [ADR-0006](0006-guard-model-size.md) used 4,096); issue #29 measures it before Milestone 2 ships.

## Evidence

Measured with `qwen2.5:7b` on Ollama 0.40.15, 2026-11-12:

- When history overflowed, Ollama dropped the oldest messages and kept the system message.
- When a single message overflowed a 1,024-token context, Ollama kept only its last 514 tokens and dropped the system prompt, returning HTTP 200.
- `<|im_start|>`, `<|im_end|>`, `<tool_call>`, `</tool_call>` and `<|endoftext|>` inside user content were each tokenised as one special token, and a forged system turn inside a user message made the model reply "PWNED".
- Ollama's default context is 4,096 tokens: https://docs.ollama.com/faq (accessed 2026-11-12).
- Bing turn caps after long-session drift: https://blogs.bing.com/search/february-2023/The-new-Bing-Edge-Updates-to-Chat (accessed 2026-11-12).
