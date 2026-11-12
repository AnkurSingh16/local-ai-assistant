import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests run against workspace sources, so no package has to be built first.
  resolve: { conditions: ['@local-ai/source'] },
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
    exclude: [...configDefaults.exclude, '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/index.ts'],
      reporter: ['text-summary', 'lcov', 'json-summary'],
      thresholds: { lines: 85 },
    },
  },
});
