import type { Assistant } from '@local-ai/agent';
import { createAssistant } from '@local-ai/agent';
import type { ChatProvider, ModerationProvider } from '@local-ai/core';
import { createInputGuard, createOutputGuard } from '@local-ai/guardrails';
import { createOllamaChatProvider, createOllamaModerationProvider } from '@local-ai/providers';
import { createMockChatProvider, createMockModerationProvider } from '@local-ai/providers/mock';

import type { Config } from './config.js';

/**
 * The composition root (ADR-0002): the only module in the API that imports
 * providers. Routes receive the assistant and nothing else.
 */
export interface Composition {
  readonly assistant: Assistant;
  readonly moderation: ModerationProvider;
}

export function compose(config: Config, newId: () => string): Composition {
  let chat: ChatProvider;
  let moderation: ModerationProvider;
  if (config.providers === 'mock') {
    chat = createMockChatProvider({ delayMs: 20 });
    moderation = createMockModerationProvider();
  } else {
    const fetchFn = (input: string, init: RequestInit): Promise<Response> => fetch(input, init);
    chat = createOllamaChatProvider({
      baseUrl: config.ollamaBaseUrl,
      model: config.chatModel,
      keepAlive: config.ollamaKeepAlive,
      fetch: fetchFn,
    });
    moderation = createOllamaModerationProvider({
      baseUrl: config.ollamaBaseUrl,
      model: config.guardModel,
      keepAlive: config.ollamaKeepAlive,
      fetch: fetchFn,
    });
  }
  const guard = { moderation, timeoutMs: config.guardTimeoutMs };
  const assistant = createAssistant({
    chat,
    inputGuard: createInputGuard(guard),
    outputGuard: createOutputGuard(guard),
    newId,
    turnTimeoutMs: config.turnTimeoutMs,
  });
  return { assistant, moderation };
}
