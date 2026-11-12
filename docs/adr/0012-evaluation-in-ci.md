# ADR-0012: Red-team and routing evaluation, in CI and locally

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Ankur Pawar

## Context

The red-team set (at least 100 prompts) must run in CI, where no workflow may call Ollama, SearXNG or the internet, and a harmful output must fail the build. CI cannot produce real model output, so it needs another source of "outputs" to judge.

## Options considered

1. **Run only the input side in CI.** Easy, but output moderation and persona stability go unchecked until I run it by hand.
2. **Replay recorded outputs and verdicts in CI, and run live locally.**

## Decision

Option 2, in `packages/eval`.

- **Cases** are versioned JSON files: an id, a category (hate and harassment, sexual content, minors, violence, self-harm, extremism, abusive language, illegal activity, personal data, role-play override, instruction override, system-prompt extraction, encoded instructions, indirect injection through web content, persona change, political opinion, claimed feelings, claimed humanity, and benign look-alikes), the input or the page content, and the expected behaviour (`refuse`, `self_harm_resources`, `answer`, `no_harm`, `known_gap`). `no_harm` is for persona cases, where answering and withholding are both acceptable and only a released harmful paragraph fails; `known_gap` marks a case the layers miss today, reported rather than failed so it stays visible. `answer_without_following_injection` arrives with the indirect-injection cases in Milestone 4.
- **Recorded fixtures** hold, for each case, the real chat model's output paragraphs and the real guard verdicts captured locally with `npm run eval:record`, tagged with the model digests ([ADR-0010](0010-process-topology-and-pinning.md)). Each output paragraph is labelled by me as harmful or not; re-recording keeps existing labels by paragraph text and lists new paragraphs for labelling. A few synthetic cases carry hand-written answers that break persona, so CI exercises the output rules even when the real model keeps its persona. A replay that needs a verdict or answer the fixtures do not hold fails as stale rather than passing as a guard outage.
- **In CI**, `npm run eval:redteam` runs the full pipeline with the mock chat provider replaying the recorded outputs and the mock moderator replaying recorded verdicts, plus the real rules baseline. The build fails if any paragraph I labelled harmful would be released, if any input expected to be refused reaches the chat provider, or if a self-harm case does not return crisis resources. It also reports, without failing, the false-positive rate on benign look-alikes.
- **Locally**, `npm run eval:redteam:live` runs the same cases against Ollama with `llama-guard3`, and `npm run eval:routing` measures search routing recall and precision. Results are written to `docs/guides/safety.md` exactly as measured, with the date, the models and digests, and the command.
- The workflow runs on every PR and whenever the persona, prompts, rules or eval files change.

## Consequences

- CI catches regressions in rules, ordering, buffering and refusal handling without any model. It cannot catch a model that changed behaviour; re-recording fixtures after a model or prompt change is part of that change's PR.
- The repository is public, so fixtures must be non-operational. When I label a recorded paragraph harmful, I redact any operational detail (steps, quantities, targets) and keep only enough to show the category; CI replays the guard verdict recorded from the original, so the build still checks that the paragraph would be withheld. Fixtures live under `packages/eval/fixtures/` and are never shown in the app.

## Evidence

- The no-model rule for CI is a fixed requirement ([requirements](../architecture/requirements.md)).
