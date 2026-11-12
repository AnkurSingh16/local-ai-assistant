import { createChatClient } from '@local-ai/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './styles.css';

// Same origin: the Vite dev and preview servers proxy /v1 to the API.
const client = createChatClient({ baseUrl: '', fetch: (input, init) => fetch(input, init) });

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  );
}
