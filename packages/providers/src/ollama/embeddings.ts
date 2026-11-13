import type { EmbeddingProvider } from '@local-ai/core';
import { ProviderError } from '@local-ai/core';
import { z } from 'zod';

import type { FetchFn } from '../shared/http.js';
import { parseJsonLine, postJson } from '../shared/http.js';
import { readCapped } from '../shared/ndjson.js';

export interface OllamaEmbeddingConfig {
  readonly baseUrl: string;
  /** nomic-embed-text, pinned by digest in ADR-0010. */
  readonly model: string;
  readonly keepAlive: string;
  readonly fetch: FetchFn;
}

/** nomic-embed-text returns 768 numbers per text. */
export const nomicDimensions = 768;
/** A few texts of 768 floats each fit easily; this bounds a broken server. */
const maxResponseChars = 4 * 1024 * 1024;

const responseSchema = z.object({ embeddings: z.array(z.array(z.number())) });

/** Embeddings through Ollama's /api/embed (ADR-0001: no second inference runtime). */
export function createOllamaEmbeddingProvider(config: OllamaEmbeddingConfig): EmbeddingProvider {
  const url = new URL('/api/embed', config.baseUrl).toString();
  return {
    model: config.model,
    dimensions: nomicDimensions,
    async embed(texts, signal) {
      if (texts.length === 0) return [];
      const res = await postJson(
        config.fetch,
        url,
        {
          model: config.model,
          input: texts,
          keep_alive: config.keepAlive,
          options: { num_ctx: 2048 },
        },
        signal,
      );
      if (res.body === null) throw new ProviderError('bad_response', res.status);
      const parsed = responseSchema.safeParse(
        parseJsonLine(await readCapped(res.body, maxResponseChars, signal)),
      );
      if (
        !parsed.success ||
        parsed.data.embeddings.length !== texts.length ||
        parsed.data.embeddings.some((e) => e.length !== nomicDimensions)
      ) {
        throw new ProviderError('bad_response', res.status);
      }
      return parsed.data.embeddings.map((e) => Float32Array.from(e));
    },
  };
}
