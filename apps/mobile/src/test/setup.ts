import Module from 'node:module';
import { fileURLToPath } from 'node:url';

import { afterEach } from 'vitest';

// React Native Testing Library is CommonJS and loads react-native through
// Node's require, which Vite's alias does not reach. React Native's own entry
// is Flow source, so that one request is pointed at a small stub instead.
const stub = fileURLToPath(new URL('./react-native-stub.cjs', import.meta.url));
const original: unknown = Reflect.get(Module, '_resolveFilename');
if (typeof original === 'function') {
  Reflect.set(
    Module,
    '_resolveFilename',
    function resolve(this: unknown, request: unknown, ...rest: unknown[]) {
      if (request === 'react-native') return stub;
      return Reflect.apply(original, this, [request, ...rest]) as unknown;
    },
  );
}

// React reads this to know updates are wrapped in act(), as under Jest.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { cleanup } = await import('@testing-library/react-native/dist/pure');
// Cleanup is asynchronous in this version; awaiting it keeps screen bound to the next render.
afterEach(async () => {
  await cleanup();
});
