import type { EmbeddingProvider } from '@local-ai/core';

/** nomic-embed-text produces 768 dimensions; the mock matches so stored vectors have the real shape. */
export const mockEmbeddingDimensions = 768;

/** 32-bit FNV-1a, used only to seed the generator from the text. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Same text, same unit vector; different texts, nearly orthogonal vectors. */
function vectorFor(text: string, dimensions: number): Float32Array {
  let state = fnv1a(text) || 1;
  const out = new Float32Array(dimensions);
  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const value = (state >>> 0) / 0xffffffff - 0.5;
    out[i] = value;
    norm += value * value;
  }
  const scale = 1 / Math.sqrt(norm);
  return out.map((v) => v * scale);
}

export function createMockEmbeddingProvider(
  dimensions: number = mockEmbeddingDimensions,
): EmbeddingProvider {
  return {
    model: 'mock-embed',
    dimensions,
    embed(texts: readonly string[], signal: AbortSignal): Promise<Float32Array[]> {
      // Deferred so an aborted signal rejects the promise instead of throwing synchronously.
      return Promise.resolve().then(() => {
        signal.throwIfAborted();
        return texts.map((t) => vectorFor(t, dimensions));
      });
    },
  };
}
