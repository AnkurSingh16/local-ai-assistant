import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  resolve: { conditions: ['@local-ai/source'] },
  test: {
    name: 'core',
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
