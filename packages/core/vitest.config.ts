import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'core',
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
