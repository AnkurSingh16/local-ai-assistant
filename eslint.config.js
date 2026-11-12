// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';

import noBrandCast from './eslint-rules/no-brand-cast.js';

const injectedSelectors = [
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message: 'Use an injected Clock instead of Date.now().',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'Use an injected Clock instead of new Date().',
  },
  {
    selector: "MemberExpression[object.name='performance'][property.name='now']",
    message: 'Use Clock.monotonicMs() instead of performance.now().',
  },
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: 'Read configuration in the app config module and inject it.',
  },
];

const brandMintFiles = ['packages/guardrails/src/mint.ts', 'packages/tools/src/untrusted.ts'];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // Rule-tester inputs, linted by the tests themselves.
      'eslint-rules/fixtures/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Package configs are covered by each package's tsconfig.json; only root configs need this.
          allowDefaultProject: ['*.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      // A TODO in main means unfinished work shipped; track it as an issue instead.
      'no-warning-comments': [
        'error',
        { terms: ['todo', 'fixme', 'xxx', 'hack'], location: 'anywhere' },
      ],
      'no-console': 'error',
    },
  },
  {
    // Brands are minted in one file each; a cast anywhere else would let unmoderated
    // or unwrapped text through the guard boundary (ADR-0002). The rule is type-aware,
    // so aliases, renamed imports and nested fields are caught too.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: brandMintFiles,
    plugins: {
      local: { rules: { 'no-brand-cast': noBrandCast } },
      'eslint-comments': eslintComments,
    },
    rules: {
      'local/no-brand-cast': 'error',
      // A disable comment would switch the guard off silently, so it is itself an error.
      'eslint-comments/no-restricted-disable': ['error', 'local/no-brand-cast'],
      'eslint-comments/no-unlimited-disable': 'error',
    },
  },
  {
    // Time and environment are injected, so domain code stays deterministic under test.
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    // The eval runner's live-config.ts is its composition root's config module, like apps/*/src/config.ts.
    ignores: [
      '**/*.test.{ts,tsx}',
      'packages/core/src/clock.ts',
      'apps/*/src/config.ts',
      'packages/eval/src/cli/live-config.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', ...injectedSelectors] },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
