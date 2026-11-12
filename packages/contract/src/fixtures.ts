import type { SseEvent } from './events.js';

/**
 * Shared turns used by the contract tests on both sides of the wire: the API's
 * tests check it produces events of these shapes, and the client tests check it
 * parses them back exactly, whatever the chunking.
 */
const conversationId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const messageId = '0f8fad5b-d9cb-469f-a165-70867728950e';

export const fixtureTurns: Readonly<Record<string, readonly SseEvent[]>> = {
  answered: [
    { type: 'meta', conversationId, messageId },
    { type: 'status', phase: 'moderating' },
    { type: 'status', phase: 'answering' },
    { type: 'delta', text: 'First paragraph, with "quotes" and unicode: café, 東京, 🌈.\n\n' },
    { type: 'delta', text: '```ts\nconst a = 1;\n\nconst b = 2;\n```' },
    { type: 'citation', n: 1, url: 'https://example.com/a?b=c', title: 'Example' },
    { type: 'done', finishReason: 'stop' },
  ],
  refused: [
    { type: 'meta', conversationId, messageId },
    { type: 'status', phase: 'moderating' },
    { type: 'refusal', kind: 'policy', message: "I can't help with that." },
    { type: 'done', finishReason: 'refused' },
  ],
  refusedMidAnswer: [
    { type: 'meta', conversationId, messageId },
    { type: 'status', phase: 'moderating' },
    { type: 'status', phase: 'answering' },
    { type: 'delta', text: 'Released before the flag.' },
    { type: 'refusal', kind: 'policy', message: "I can't help with that." },
    { type: 'done', finishReason: 'refused' },
  ],
  failed: [
    { type: 'meta', conversationId, messageId },
    { type: 'status', phase: 'moderating' },
    {
      type: 'error',
      code: 'model_unavailable',
      message: 'The assistant is not available right now.',
      requestId: 'req-1',
      retryable: true,
    },
    { type: 'done', finishReason: 'error' },
  ],
};

export const fixtureMessageId = messageId;
