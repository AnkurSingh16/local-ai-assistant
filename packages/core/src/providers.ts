import type { ChatChunk, ChatRequest } from './chat.js';

/**
 * Provider interfaces (ADR-0002). Every method takes an AbortSignal, and no
 * implementation reads the environment: configuration is passed in by the
 * composition root, so a hosted API can replace a local model without touching
 * domain code.
 */

export interface ChatProvider {
  /** Streams the reply. It ends with exactly one `done` chunk unless the signal aborts. */
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
}

export interface SearchQuery {
  readonly query: string;
  readonly limit: number;
}

export interface SearchResult {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
}

export interface SearchProvider {
  search(q: SearchQuery, signal: AbortSignal): Promise<SearchResult[]>;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], signal: AbortSignal): Promise<Float32Array[]>;
}

/** The hazard categories reported by llama-guard3 (MLCommons taxonomy, S1 to S14). */
export const hazardCategories = [
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
  'S7',
  'S8',
  'S9',
  'S10',
  'S11',
  'S12',
  'S13',
  'S14',
] as const;

export type HazardCategory = (typeof hazardCategories)[number];

export interface ModerationInput {
  /** Whose text is being classified: the user's message or a paragraph of the assistant's answer. */
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export type ModerationVerdict =
  | { readonly flagged: false }
  | { readonly flagged: true; readonly categories: readonly HazardCategory[] };

export interface ModerationProvider {
  classify(input: ModerationInput, signal: AbortSignal): Promise<ModerationVerdict>;
}
