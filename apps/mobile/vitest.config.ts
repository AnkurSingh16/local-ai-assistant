import { fileURLToPath } from 'node:url';

import { configDefaults, defineProject } from 'vitest/config';

const conditions = ['@local-ai/source'];
const reactNative = fileURLToPath(new URL('./src/test/react-native.tsx', import.meta.url));

export default defineProject({
  resolve: { conditions, alias: { 'react-native': reactNative } },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    name: 'mobile',
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
