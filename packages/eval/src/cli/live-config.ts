import type { LiveConfig } from '../live.js';

/** The eval runner is a composition root (ADR-0002), so it reads its settings here. */
export function liveConfigFromEnv(): LiveConfig {
  return {
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    chatModel: process.env.CHAT_MODEL ?? 'qwen2.5:7b',
    guardModel: process.env.GUARD_MODEL ?? 'llama-guard3:1b',
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
  };
}

/** The embedding model for the memory recall eval. */
export function embedModelFromEnv(): string {
  return process.env.EMBED_MODEL ?? 'nomic-embed-text';
}
