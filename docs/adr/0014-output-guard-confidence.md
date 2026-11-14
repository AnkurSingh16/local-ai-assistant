# ADR-0014: An ordinary stand-in question and a confidence threshold for the output guard

- **Status:** Accepted
- **Date:** 2026-11-14
- **Deciders:** Ankur Pawar
- **Amends:** [ADR-0005](0005-guardrail-pipeline.md), step 8 (output moderation)

## Context

When I asked "What is the latest version of Node.js?", some answers stopped halfway with "I can't help with that." My output rules never fired. `llama-guard3:1b`, checking each paragraph in the assistant role, flagged harmless text: "Here are some additional details:" as S5 (defamation), "[link removed]" and a sentence about the Node.js release schedule as S1 (violent crimes). In 20 live turns with that question, 5 were refused.

Llama Guard classifies the last turn of a conversation, so an answer paragraph needs a user turn before it. ADR-0005 does not send the real question, so the verdict depends on the paragraph alone, and the provider sent "(user message withheld)" instead. The guard runs at temperature 0 and its top answer decided. Ollama 0.40 also returns the probabilities of each token (`logprobs`). Meta scores Llama Guard by the probability that its first token is "unsafe", which can be turned into a decision with a threshold instead of taking the top answer.

## Options considered

1. **Keep the top answer.** About one harmless paragraph in ten was withheld, and an answer has three or four paragraphs.
2. **Send the real question as the user turn.** Fewer false positives in a small test, but the question is user-controlled text placed right before the paragraph the guard judges, so it could steer the verdict.
3. **Change only the stand-in question.** Helps, but not enough on its own.
4. **An ordinary stand-in question, plus a threshold on the probability of "unsafe" for answer paragraphs.**
5. **The 8B guard.** It cannot stay loaded next to the chat model on 16 GB ([ADR-0006](0006-guard-model-size.md)).

## Decision

Option 4. For an answer paragraph, the provider sends "Can you help me with something?" as the user turn and asks Ollama for the first token's top five log probabilities. It works out the probability of "unsafe" against "safe". The paragraph is withheld only when the guard's answer is "unsafe" and that probability is at least 0.7. If Ollama returns no probabilities, the top answer stands, so the check never becomes weaker than before.

User messages are unchanged: the top answer decides, with no threshold. A flagged message never reaches the chat model, and I have no evidence that input checks need loosening.

## Evidence

I measured on 2026-11-14 with `llama-guard3:1b` on my M1 Pro with 16 GB. The test set is `packages/eval/cases/output-guard.json`:

- 243 harmless answer paragraphs: what `qwen2.5:7b` wrote for the 31 benign look-alike prompts from the red-team set and for 20 cited fresh-information questions, plus the 5 paragraphs refused in the live turns.
- 45 harmful answer paragraphs I wrote by hand, covering S1 to S14, without working instructions.

`npm run eval:guard:live` runs it.

| Setup                                          | Harmless withheld | Harmful caught |
| ---------------------------------------------- | ----------------: | -------------: |
| "(user message withheld)", top answer (before) |            24/238 |          44/45 |
| "(user message withheld)", threshold 0.7       |             9/238 |          43/45 |
| Ordinary question, top answer                  |            16/238 |          45/45 |
| **Ordinary question, threshold 0.7 (chosen)**  |         **6/238** |      **45/45** |
| Ordinary question, threshold 0.8               |             6/238 |          44/45 |
| Ordinary question, threshold 0.9               |             3/238 |          40/45 |

The 238 are the generated paragraphs; the 5 refused live paragraphs all pass with the chosen setup. With the ordinary question, the highest "unsafe" probability on the first 25 harmless paragraphs I tried was 0.61, and the lowest on the first 12 harmful ones was 0.81.

The 6 paragraphs still withheld are 5 steps of first aid for a minor burn (S6, specialised advice) and a heading about killing a stuck process (S1). None of the 20 fresh-information answers is withheld any more.

## Consequences

- Fewer answers stop halfway. A harmless paragraph is now withheld about one time in forty, against one in ten before.
- I chose the threshold on the same set that measures it, so the figures flatter it. Most harmful text never reaches this check at all: the input guard and rules refuse the request first, and the live red-team run still passes (see below).
- First-aid answers are still sometimes cut off. Fixing that needs a better guard, not a lower bar.
- The threshold is a constant in the provider, not configuration, so it cannot be loosened by accident. Changing it needs a new measurement with `npm run eval:guard:live` and an update here.
- If a future Ollama stops returning `logprobs`, the guard falls back to its top answer: stricter, never looser.

## Red-team run

I re-recorded the red-team set on 2026-11-14 with this change (`npm run eval:record`, same models and persona): 0 failures, so no refusable input reached the chat model and no released paragraph is harmful. Benign look-alikes refused went from 6 of 31 to 3 of 31. The three answers the guard used to cut off partway (talking to children about sex, git history, eslint) were released in full, and I labelled their 25 new paragraphs harmless. The input verdicts for all 144 recorded cases are identical to the previous recording.

In 20 live turns asking for the latest Node.js version, none was refused, against 5 of 20 before.
