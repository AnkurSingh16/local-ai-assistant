import { configDefaults, defineProject } from 'vitest/config';

const conditions = ['@local-ai/source'];

export default defineProject({
  // Node-environment tests resolve through the SSR settings, so the source condition is set on both.
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    name: 'contract',
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
