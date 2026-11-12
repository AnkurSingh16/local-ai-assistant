import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout, so it does not implement scrollIntoView.
Element.prototype.scrollIntoView = function scrollIntoView() {
  // Nothing to scroll in a document without layout.
};

// Vitest globals are off, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
});
