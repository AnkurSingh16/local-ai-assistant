/**
 * Real provider adapters. Only the composition roots import this entry point
 * (dependency-cruiser rule providers-only-from-compose).
 */
export { createOllamaChatProvider } from './ollama/chat.js';
export type { OllamaChatConfig } from './ollama/chat.js';
export type { FetchFn } from './ollama/http.js';
export {
  createOllamaModerationProvider,
  guardNumCtx,
  parseGuardVerdict,
} from './ollama/moderation.js';
export type { OllamaModerationConfig } from './ollama/moderation.js';
