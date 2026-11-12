import type { ChatChunk, ChatProvider, ChatRequest } from '@local-ai/core';

import { sleep } from './sleep.js';

export const defaultMockAnswer = 'This is a mock answer from the test chat provider.';

export interface MockChatOptions {
  /** Builds the chunks for a request. Defaults to a fixed answer split into word-sized chunks. */
  readonly reply?: (req: ChatRequest) => readonly ChatChunk[];
  /** Pause before each chunk, so streaming and cancellation can be observed. */
  readonly delayMs?: number;
}

export interface MockChatProvider extends ChatProvider {
  /** Every request received, in order. The route-inventory test asserts this stays empty. */
  readonly calls: readonly ChatRequest[];
}

/** Splits text into chunks that keep their trailing whitespace, the way a model streams tokens. */
export function textChunks(text: string): ChatChunk[] {
  const pieces = text.match(/\S+\s*|\s+/g) ?? [];
  return pieces.map((piece) => ({ type: 'text', text: piece }));
}

/** A complete reply: the text as chunks, then a `stop` chunk with character-based usage. */
export function mockReply(text: string, req: ChatRequest): ChatChunk[] {
  const promptChars = req.messages.reduce((sum, m) => sum + m.content.length, 0);
  return [
    ...textChunks(text),
    {
      type: 'done',
      finishReason: 'stop',
      usage: { promptTokens: Math.ceil(promptChars / 4), outputTokens: Math.ceil(text.length / 4) },
    },
  ];
}

export function createMockChatProvider(options: MockChatOptions = {}): MockChatProvider {
  const calls: ChatRequest[] = [];
  const reply = options.reply ?? ((req: ChatRequest) => mockReply(defaultMockAnswer, req));
  const delayMs = options.delayMs ?? 0;
  return {
    calls,
    async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
      calls.push(req);
      for (const chunk of reply(req)) {
        await sleep(delayMs, signal);
        yield chunk;
      }
    },
  };
}
