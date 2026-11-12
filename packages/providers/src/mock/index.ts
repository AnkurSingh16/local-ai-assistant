/**
 * Deterministic providers, the default in tests and CI. They never touch the
 * network, so CI runs without Ollama, SearXNG or internet access.
 */
export { createMockChatProvider, defaultMockAnswer, mockReply, textChunks } from './chat.js';
export type { MockChatOptions, MockChatProvider } from './chat.js';
export { createMockEmbeddingProvider, mockEmbeddingDimensions } from './embeddings.js';
export { createMockModerationProvider, mockFlagMarkers } from './moderation.js';
export type { MockModerationOptions, MockModerationProvider } from './moderation.js';
export { createMockSearchProvider } from './search.js';
export type { MockSearchOptions, MockSearchProvider } from './search.js';
