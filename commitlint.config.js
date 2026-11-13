export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot writes long release-note bodies that would break line-length rules.
  ignores: [(message) => message.includes('Signed-off-by: dependabot[bot]')],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'api',
        'web',
        'mobile',
        'client',
        'agent',
        'core',
        'providers',
        'guardrails',
        'tools',
        'storage',
        'eval',
        'docs',
        'ci',
        'deps',
        'repo',
      ],
    ],
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
  },
};
