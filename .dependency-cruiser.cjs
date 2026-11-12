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
        pathNot: ['\\.d\\.ts$', '(^|/)tsconfig\\.json$', '\\.config\\.(js|cjs|mjs|ts)$'],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
