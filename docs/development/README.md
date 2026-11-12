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

- `providers-only-from-compose`: only `apps/api/src/compose.ts`, the eval runner and test files import `@local-ai/providers`.
- `tests-use-mock-providers`: tests outside the providers package import only `@local-ai/providers/mock`.
- `storage-not-from-routes` and `tools-not-to-storage`: routes and tools never reach the stores directly. These two have no code to check until `apps/api`, `storage` and `tools` exist; I checked each rule against a temporary violating file.
- `local/no-brand-cast` (in `eslint-rules/`) asks the type checker whether a cast, an explicit type argument or a type predicate produces `ModeratedText` or `UntrustedWebText`, including through aliases, renamed imports, qualified names, unions, arrays and nested object fields. It also rejects casts to `never` and to a bare type parameter, which could launder any value. Only `guardrails/src/mint.ts` and `tools/src/untrusted.ts` are exempt. Its fixture tests list every form it catches.
- What it cannot see: a value typed `any` (already rejected by the `no-unsafe-*` rules) and a library function whose return type the caller picks without a type argument. Review covers those.

## Mock providers

`@local-ai/providers/mock` holds deterministic providers for chat, search, embeddings and moderation. They are the default in tests and CI, and none of them touches the network.

- The chat mock streams a fixed answer in word-sized chunks, or a scripted reply, and records every request in `calls`. A test that expects the model never to be reached asserts `calls` is empty.
- The moderation mock flags text containing `MOCK_FLAG` (category S1) or `MOCK_FLAG_SELF_HARM` (S11), so tests state intent without containing harmful text. A scripted classifier that throws simulates a guard outage.
- The embedding mock returns the same unit vector for the same text, with 768 dimensions like `nomic-embed-text`.
- Every mock honours its `AbortSignal`, and an optional `delayMs` makes streaming and cancellation observable.

## Workflows

| Workflow      | Runs on          | What it checks                                                    |
| ------------- | ---------------- | ----------------------------------------------------------------- |
| CI            | push, PR         | Format, lint, typecheck, boundaries, tests with coverage, build   |
| Commits       | PR               | Every commit message passes commitlint                            |
| PR title      | PR               | Title is a Conventional Commit                                    |
| Security      | push, PR, weekly | CodeQL, dependency review, gitleaks, `npm audit`                  |
| End-to-end    | PR               | Playwright against the web client (from Milestone 2)              |
| Red-team eval | PR               | The red-team set with mock and rules providers (from Milestone 3) |

Dependabot opens weekly grouped updates for npm and GitHub Actions. No workflow needs a paid API key or calls Ollama, SearXNG or the internet beyond package and action downloads.
