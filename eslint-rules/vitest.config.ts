import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'eslint-rules', environment: 'node', include: ['*.test.ts'] },
});
