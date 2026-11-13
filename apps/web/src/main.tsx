import type { ChatClient } from '@local-ai/client';
import { createAccountClient, createChatClient } from '@local-ai/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './styles.css';

// Same origin: the Vite dev and preview servers proxy /v1 to the API.
const sameOrigin = createChatClient({ baseUrl: '', fetch: (input, init) => fetch(input, init) });
const account = createAccountClient({ baseUrl: '', fetch: (input, init) => fetch(input, init) });

// A session makes conversations remembered (ADR-0009). Starting one is best
// effort: without it the assistant still answers, just without memory.
const sessionReady = (async () => {
  const signal = AbortSignal.timeout(10_000);
  try {
    if (!(await account.hasSession(signal))) await account.startSession(signal);
  } catch {
    // The app works statelessly until the next load.
  }
})();

// A message sent before the session cookie exists would start a conversation
// that later turns cannot continue, so the first send waits for it.
const client: ChatClient = {
  async *send(body, signal) {
    await sessionReady;
    yield* sameOrigin.send(body, signal);
  },
};

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App client={client} account={account} />
    </StrictMode>,
  );
}
