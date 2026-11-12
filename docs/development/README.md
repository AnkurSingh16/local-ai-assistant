# Development

## Workflow

1. Every change starts from an issue in a milestone.
2. I branch from `main` as `<type>/<short-name>`, for example `feat/web-search`.
3. Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with a scope from `commitlint.config.js`. A `commit-msg` hook runs commitlint.
4. PRs are small and use the template: summary, issue, ADR, test evidence, docs, risks and rollback.
5. PRs are squash-merged, so the PR title becomes the commit on `main` and must itself be a valid Conventional Commit. A workflow checks it.
6. `main` is protected: changes land only through PRs with green checks.

## Checks

```bash
npm run check
```

That runs, in order: Prettier, ESLint (strict type-checked), `tsc -b`, dependency-cruiser boundaries, and Vitest with coverage. CI fails below 85% line coverage.

## Code conventions

- No `any`, non-null assertions or unchecked casts. External input is validated with Zod at the boundary.
- Providers, clocks and fetch are injected. Tests use mock providers and `createManualClock`.
- Comments explain why. No TODOs: open an issue instead (ESLint enforces this).
- Domain code never reads `Date.now()`, `new Date()`, `performance.now()` or `process.env`. ESLint catches the common spellings of these everywhere except `clock.ts` and each app's `config.ts`; review catches the rest.

## Workspace packages

Each package exports a custom `@local-ai/source` condition that points at its TypeScript sources. Vitest, the per-package typecheck and dependency-cruiser resolve through it, so tests run without building first and boundary rules see real source paths. The production build (`tsconfig.build.json`) ignores the condition, emits to `dist/` and leaves test files out. Vitest runs node tests through Vite's SSR resolver, so each package's `vitest.config.ts` sets the condition under both `resolve` and `ssr.resolve`; without the second, tests silently load a stale `dist/` when one exists.

## Boundaries

dependency-cruiser and ESLint enforce the guard boundary from ADR-0002:

- `providers-only-from-compose`: only `apps/api/src/compose.ts`, the eval runner's `live.ts` (real providers) and `replay.ts` (mocks), and test files import `@local-ai/providers`.
- `tests-use-mock-providers`: tests outside the providers package import only `@local-ai/providers/mock`.
- `storage-not-from-routes` and `tools-not-to-storage`: routes and tools never reach the stores directly. These two have no code to check until `apps/api`, `storage` and `tools` exist; I checked each rule against a temporary violating file.
- `local/no-brand-cast` (in `eslint-rules/`) asks the type checker whether code asserts a `ModeratedText` or `UntrustedWebText` without producing one: a cast, an explicit type argument, a type predicate, an overload or `declare function` signature, or an ambient `declare` variable or class. It follows aliases, renamed imports, qualified names, unions, arrays and nested fields. It also rejects any cast whose target contains `never` or a type parameter, since those can launder any value. Only `guardrails/src/mint.ts` and `tools/src/untrusted.ts` are exempt, and a comment that disables it is itself a lint error.
- The rule is a tripwire for the forms in its fixtures, not a proof: TypeScript cannot make a brand unforgeable. It does not see values typed `any` (the `no-unsafe-*` rules reject those) or a library function whose return type the caller picks without a type argument. The end-to-end guarantee comes from the route-inventory test, which asserts the model is never reached when moderation flags everything. It lands with the API (issue #9), and no route merges without it.
- A false positive, such as a reasonable generic helper casting to `readonly T[]`, is fixed by narrowing the rule with a new fixture after I review the change, not by a disable comment (those are banned).

## Mock providers

`@local-ai/providers/mock` holds deterministic providers for chat, search, embeddings and moderation. They are the default in tests and CI, and none of them touches the network.

- The chat mock streams a fixed answer in word-sized chunks, or a scripted reply, and records every request in `calls`. A test that expects the model never to be reached asserts `calls` is empty.
- The moderation mock flags text containing `MOCK_FLAG` (category S1) or `MOCK_FLAG_SELF_HARM` (S11), so tests state intent without containing harmful text. A scripted classifier that throws simulates a guard outage.
- The embedding mock returns the same unit vector for the same text, with 768 dimensions like `nomic-embed-text`.
- Every mock honours its `AbortSignal`, and an optional `delayMs` makes streaming and cancellation observable.

## End-to-end tests

```bash
npm run e2e
```

Playwright builds the web app and serves it with `vite preview`, so the tests also run under the production Content Security Policy. It starts the API with `PROVIDERS=mock`, both on ports of their own (5317 and 8917), so a dev server you already have running is never reused by mistake. Any console error, including a CSP violation, fails the test. Run `npx playwright install chromium` in `apps/web` once first.

## Red-team eval

The cases live in `packages/eval/cases/redteam.json` and the recorded answers and guard verdicts in `packages/eval/fixtures/redteam.recorded.json` ([ADR-0012](../adr/0012-evaluation-in-ci.md)).

```bash
npm run eval:redteam        # replay, as CI does; no Ollama needed
```

```bash
npm run eval:record         # re-record against Ollama after a model, persona or prompt change
```

```bash
npm run eval:redteam:live   # run against Ollama without touching the fixtures
```

Re-recording keeps my harmful labels by paragraph text and lists new paragraphs to label. Check that no other Ollama client is running first; a second client at a different context size makes models reload mid-run.

## Workflows

| Workflow      | Runs on          | What it checks                                                        |
| ------------- | ---------------- | --------------------------------------------------------------------- |
| CI            | push, PR         | Format, lint, typecheck, boundaries, tests with coverage, build       |
| Commits       | PR               | Every commit message passes commitlint                                |
| PR title      | PR               | Title is a Conventional Commit                                        |
| Security      | push, PR, weekly | CodeQL, dependency review, gitleaks, `npm audit`                      |
| End-to-end    | push, PR         | Playwright against the built web app and the API on mock providers    |
| Red-team eval | push, PR         | Replays the recorded red-team set through the real rules and pipeline |

Dependabot opens weekly grouped updates for npm and GitHub Actions. No workflow needs a paid API key or calls Ollama, SearXNG or the internet beyond package and action downloads.
