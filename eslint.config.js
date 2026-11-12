// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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

const brandNames = '/^(ModeratedText|UntrustedWebText)$/';
const brandMessage =
  'ModeratedText and UntrustedWebText are minted only in guardrails/src/mint.ts and tools/src/untrusted.ts.';
const brandSelectors = [
  {
    selector: `TSAsExpression > TSTypeReference[typeName.name=${brandNames}]`,
    message: brandMessage,
  },
  {
    selector: `TSTypeAssertion > TSTypeReference[typeName.name=${brandNames}]`,
    message: brandMessage,
  },
  {
    // Catches helpers such as brand<ModeratedText>(text) that would hide the cast.
    selector: `CallExpression > TSTypeParameterInstantiation TSTypeReference[typeName.name=${brandNames}]`,
    message: brandMessage,
  },
];

const brandMintFiles = ['packages/guardrails/src/mint.ts', 'packages/tools/src/untrusted.ts'];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.tsbuildinfo'],
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
    // or unwrapped text through the guard boundary (ADR-0002).
    files: ['**/*.ts', '**/*.tsx'],
    ignores: brandMintFiles,
    rules: { 'no-restricted-syntax': ['error', ...brandSelectors] },
  },
  {
    // Time and environment are injected, so domain code stays deterministic under test.
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', 'packages/core/src/clock.ts', 'apps/*/src/config.ts'],
    rules: { 'no-restricted-syntax': ['error', ...injectedSelectors, ...brandSelectors] },
  },
  {
    // The mint files still follow the injection rules; they are exempt from the brand rule only.
    files: brandMintFiles,
    rules: { 'no-restricted-syntax': ['error', ...injectedSelectors] },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
