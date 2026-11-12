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

Each package exports a custom `@local-ai/source` condition that points at its TypeScript sources. Vitest, the per-package typecheck and dependency-cruiser resolve through it, so tests run without building first and boundary rules see real source paths. The production build (`tsconfig.build.json`) ignores the condition, emits to `dist/` and leaves test files out.

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
