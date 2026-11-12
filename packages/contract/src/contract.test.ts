import { describe, expect, it } from 'vitest';

import type { SseEvent } from './index.js';
import {
  chatRequestSchema,
  encodeSseEvent,
  maxMessageChars,
  sseEventId,
  sseEventSchema,
} from './index.js';

const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('chat request schema', () => {
  it('accepts a message with or without a conversation id', () => {
    expect(chatRequestSchema.safeParse({ message: 'hi' }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ message: 'hi', conversationId: id }).success).toBe(true);
  });

  it.each([
    [{}],
    [{ message: '' }],
    [{ message: 'x'.repeat(maxMessageChars + 1) }],
    [{ message: 'hi', conversationId: 'nope' }],
    [{ message: 'hi', extra: true }],
    [{ message: 42 }],
  ])('rejects %j', (body) => {
    expect(chatRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('SSE event schema', () => {
  const valid: SseEvent[] = [
    { type: 'meta', conversationId: id, messageId: id },
    { type: 'status', phase: 'searching', detail: 'weather' },
    { type: 'delta', text: 'Hello.' },
    { type: 'citation', n: 1, url: 'https://example.com/a', title: 'A' },
    { type: 'refusal', kind: 'policy', message: 'I cannot help with that.' },
    {
      type: 'error',
      code: 'internal',
      message: 'Something went wrong.',
      requestId: 'r1',
      retryable: true,
    },
    { type: 'done', finishReason: 'stop' },
  ];

  it.each(valid)('accepts $type', (event) => {
    expect(sseEventSchema.parse(event)).toEqual(event);
  });

  it.each([
    [{ type: 'unknown' }],
    [{ type: 'delta', text: '' }],
    [{ type: 'citation', n: 1, url: 'http://example.com', title: 'plain http' }],
    [{ type: 'citation', n: 0, url: 'https://example.com', title: 'zero' }],
    [{ type: 'refusal', kind: 'because', message: 'x' }],
    [
      {
        type: 'error',
        code: 'internal',
        message: 'x',
        requestId: 'r',
        retryable: true,
        stack: 'at x',
      },
    ],
    [{ type: 'done', finishReason: 'stop', model: 'qwen2.5:7b' }],
  ])('rejects %j', (event) => {
    expect(sseEventSchema.safeParse(event).success).toBe(false);
  });
});

describe('SSE wire format', () => {
  it('frames an event on one data line, even when the text has newlines', () => {
    const frame = encodeSseEvent({ type: 'delta', text: 'one\n\ntwo' }, sseEventId(id, 3));
    expect(frame).toBe(
      `event: delta\nid: ${id}:3\ndata: {"type":"delta","text":"one\\n\\ntwo"}\n\n`,
    );
    expect(frame.split('\n\n')).toHaveLength(2);
  });
});
