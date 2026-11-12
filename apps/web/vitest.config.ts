import react from '@vitejs/plugin-react';
import { configDefaults, defineProject } from 'vitest/config';

const conditions = ['@local-ai/source'];

export default defineProject({
  plugins: [react()],
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    name: 'web',
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    exclude: [...configDefaults.exclude, '**/dist/**', 'e2e/**'],
  },
});
