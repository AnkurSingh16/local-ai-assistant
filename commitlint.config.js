export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'api',
        'web',
        'mobile',
        'client',
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
