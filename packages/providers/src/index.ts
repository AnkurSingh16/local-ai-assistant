/**
 * Real provider adapters. Only the composition roots import this entry point
 * (dependency-cruiser rule providers-only-from-compose).
 */
export { createOllamaChatProvider } from './ollama/chat.js';
export type { OllamaChatConfig } from './ollama/chat.js';
export type { FetchFn } from './shared/http.js';
export {
  createOllamaModerationProvider,
  guardNumCtx,
  parseGuardVerdict,
} from './ollama/moderation.js';
export type { OllamaModerationConfig } from './ollama/moderation.js';
export { createSearxngSearchProvider } from './searxng/search.js';
export type { SearxngConfig } from './searxng/search.js';
export { createOllamaEmbeddingProvider, nomicDimensions } from './ollama/embeddings.js';
export type { OllamaEmbeddingConfig } from './ollama/embeddings.js';
