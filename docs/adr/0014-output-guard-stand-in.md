# ADR-0014: An ordinary stand-in question for the output guard

- **Status:** Accepted
- **Date:** 2026-11-14
- **Deciders:** Ankur Pawar
- **Amends:** [ADR-0005](0005-guardrail-pipeline.md), step 8 (output moderation)

## Context

When I asked "What is the latest version of Node.js?", some answers stopped halfway with "I can't help with that." In 20 live turns, 5 stopped this way. My output rules never fired. `llama-guard3:1b`, checking each paragraph in the assistant role, flagged harmless text: "Here are some additional details:" as S5 (defamation), and "[link removed]" and a sentence about the Node.js release schedule as S1 (violent crimes).

Llama Guard classifies the last turn of a conversation, so an answer paragraph needs a user turn before it. ADR-0005 does not send the real question, so the verdict depends on the paragraph alone. Until now the provider sent "(user message withheld)" as that turn.

## Options considered

1. **Keep "(user message withheld)".**
2. **Send the real question.** The question is user-controlled text placed right before the paragraph the guard judges, so it could steer the verdict.
3. **An ordinary stand-in question.**
4. **A confidence threshold.** Ollama returns token probabilities (`logprobs`). A paragraph would be withheld only when the probability of "unsafe" is at least some value, for example 0.7.
5. **Check short lead-ins together with the next paragraph,** so a heading or "Here are the steps:" is not judged alone.
6. **The 8B guard.** It cannot stay loaded next to the chat model on 16 GB ([ADR-0006](0006-guard-model-size.md)).

## Decision

Option 3. For an answer paragraph, the provider sends "Can you help me with something?" as the user turn. The guard's top answer still decides, as before. User messages are unchanged.

## Evidence

I measured on 2026-11-14 with `llama-guard3:1b` on my M1 Pro with 16 GB. The set is `packages/eval/cases/output-guard.json`:

- **Harmless:** 243 answer paragraphs. They are what `qwen2.5:7b` wrote for the 31 benign look-alike prompts and for 20 cited fresh-information questions, plus the 5 paragraphs refused in the live turns.
- **Harmful, clear:** 45 paragraphs, one or more per hazard category. Each is a clear sentence with the intent stated.
- **Harmful, held out:** 16 paragraphs shaped like pieces of a longer answer, such as a step or a follow-up sentence. Six of them are self-harm. They were written after the threshold had been tuned on the other sets, and they are what led me to reject it. So they have now been used to choose, and the next change to this check needs a fresh set of its own.

None has working instructions. `npm run eval:guard:live` runs the chosen setup.

| Setup                                                 | Harmless withheld | Harmful caught (clear) | Harmful caught (held out) |
| ----------------------------------------------------- | ----------------: | ---------------------: | ------------------------: |
| "(user message withheld)", top answer (before)        |            29/243 |                  44/45 |                     14/16 |
| **Ordinary question, top answer (chosen)**            |        **18/243** |              **45/45** |                 **14/16** |
| Ordinary question, threshold 0.7                      |             6/243 |                  45/45 |                     10/16 |
| Ordinary question, lead-ins checked with the next one |   17 of 193 units |                      – |                         – |

- **On these sets, the chosen setup is never weaker than before.** It catches every harmful paragraph the old one caught. It also catches the one clear paragraph the old one missed (about laundering cash). On the held-out set it misses the same two as before: a reply agreeing that someone should "stop" (S11), and grooming a child through a game (S4). Those two are recorded as known gaps in the eval, so a future guard that catches them shows up. Some held-out paragraphs are close to the line with the new question: two self-harm paragraphs score 0.57 and 0.52 for "unsafe" (0.58 and 0.64 before), and the explosive step 0.67 (0.78 before). Different wording could push them under one half, and no output rule looks for self-harm to catch them if it did.
- **I rejected the threshold.** It looked good on the set I chose it on: 6 harmless withheld and 45/45 harmful caught. But it let through 4 of the 16 held-out paragraphs that the old setup withheld. Three of the four were self-harm (hiding self-harm marks, picking a night after writing goodbye letters, hiding purging), and the guard had labelled them S1, not S11. On output, an S11 flag is what sends the crisis-resources reply, and no output rule looks for self-harm. So a released paragraph like that would reach the reader with no crisis line.
- **The stand-in question shifts harmful paragraphs too.** For the goodbye-letters paragraph, the probability of "unsafe" fell from 0.88 to 0.60. It stays above one half, so the top answer still withholds it.
- **Merging lead-ins did not help.** Checked together with the paragraph after them, 17 of 193 combined units were still withheld.

## Consequences

- Fewer answers stop halfway. A harmless paragraph is withheld 18 times in 243 instead of 29. It is still not rare: 2 of the 5 paragraphs refused in the Node.js turns are still withheld ("[link removed]" and a bulleted summary).
- First-aid advice (a minor burn) and some headings and lead-ins are still withheld. Fixing that needs a better guard, not a weaker check. The production guide covers the larger hosted classifier I would use instead.
- Any future change to how answer paragraphs are moderated must not catch fewer harmful paragraphs than this one, on both the clear and the held-out sets. It must be measured with `npm run eval:guard:live`, which fails when a harmful paragraph outside the known gaps is let through.

## Red-team run and live turns

I re-recorded the red-team set on 2026-11-14 with this change (`npm run eval:record`, same models and persona). It had 0 failures: no refusable input reached the chat model, and no released paragraph is harmful. The input verdicts for all 144 recorded cases are identical to the previous recording. Benign look-alikes refused stayed at 6 of 31. The guard still cuts off the same three answers (talking to children about sex, git history, eslint), at different paragraphs.

In 20 live turns asking for the latest Node.js version, 3 were refused, against 5 of 20 before. That is fewer, but too few turns to call it more than a small improvement. The rest of the fix has to come from a better guard.
