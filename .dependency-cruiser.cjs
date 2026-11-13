/**
 * Architectural boundaries. The rules encode the layering decided in the ADRs:
 * shared packages never reach into apps, clients never import server code, and
 * nothing outside a provider adapter talks to a vendor SDK directly.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'packages-not-to-apps',
      comment: 'Shared packages must stay reusable; they cannot depend on an application.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'apps-not-to-other-apps',
      comment: 'Applications share code only through packages.',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'clients-not-to-server-internals',
      comment: 'The web and mobile clients talk to the API over HTTP, never by importing it.',
      severity: 'error',
      from: { path: '^(apps/(web|mobile)|packages/client)/' },
      to: { path: '^(apps/api|packages/(core|providers|guardrails|tools|storage))/' },
    },
    {
      name: 'core-has-no-vendor-sdks',
      comment: 'Core depends on provider interfaces only, so hosted APIs can be added later.',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: 'node_modules/(ollama|openai|@anthropic-ai|@google)' },
    },
    {
      name: 'providers-only-from-compose',
      comment:
        'Providers are wired in the composition roots only (ADR-0002): the API compose.ts, the review command, the live eval runner (real providers) and the eval replay (mocks). Tests may use the mocks.',
      severity: 'error',
      from: {
        pathNot: [
          '^apps/api/src/compose\\.ts$',
          '^apps/api/src/review\\.ts$',
          '^packages/providers/',
          '^packages/eval/src/(live|replay)\\.ts$',
          '\\.test\\.tsx?$',
        ],
      },
      to: { path: '^packages/providers/' },
    },
    {
      name: 'tests-use-mock-providers',
      comment:
        'Tests outside the providers package may use the mocks only, so no test can reach Ollama or SearXNG.',
      severity: 'error',
      from: { path: '\\.test\\.tsx?$', pathNot: '^packages/providers/' },
      to: { path: '^packages/providers/', pathNot: '^packages/providers/src/mock/' },
    },
    {
      name: 'mint-only-from-guards',
      comment:
        'ModeratedText is minted only after a pass, so only the input and output guards may call mint.',
      severity: 'error',
      from: { pathNot: '^packages/guardrails/src/(input|output)\\.ts$' },
      to: { path: '^packages/guardrails/src/mint\\.ts$' },
    },
    {
      name: 'storage-not-from-routes',
      comment:
        'Routes reach storage only through the assistant, which accepts only moderated text.',
      severity: 'error',
      from: { path: '^apps/api/src/routes/' },
      to: { path: '^packages/storage/' },
    },
    {
      name: 'tools-not-to-storage',
      comment: 'Tools handle untrusted web content and never write to user stores.',
      severity: 'error',
      from: { path: '^packages/tools/' },
      to: { path: '^packages/storage/' },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'An import that cannot be resolved also cannot be checked against the rules above.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'not-to-test-from-src',
      severity: 'error',
      from: { path: '/src/', pathNot: '\\.test\\.tsx?$' },
      to: { path: '\\.test\\.tsx?$' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '\\.config\\.(js|cjs|mjs|ts)$',
          '(^|/)test-setup\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    // Workspace packages resolve to their sources through the custom export
    // condition, so a cross-package import is checked against its real path.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['@local-ai/source', 'import', 'require', 'node', 'default'],
    },
  },
};
