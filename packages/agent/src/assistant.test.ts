import { ProviderError } from '@local-ai/core';
import type { SseEvent } from '@local-ai/contract';
import { sseEventSchema } from '@local-ai/contract';
import { createInputGuard, createOutputGuard } from '@local-ai/guardrails';
import type { MockModerationOptions } from '@local-ai/providers/mock';
import {
  createMockChatProvider,
  createMockModerationProvider,
  mockFlagMarkers,
  mockReply,
} from '@local-ai/providers/mock';
import { describe, expect, it } from 'vitest';

import type { AssistantDeps } from './index.js';
import { buildMessages, contextBudget, createAssistant, estimateTokens, persona } from './index.js';

function ids(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

function setup(
  overrides: Partial<AssistantDeps> = {},
  moderationOptions: MockModerationOptions = {},
): { deps: AssistantDeps; chat: ReturnType<typeof createMockChatProvider> } {
  const moderation = createMockModerationProvider(moderationOptions);
  const chat = createMockChatProvider({
    reply: (req) => mockReply('First paragraph.\n\nSecond paragraph.', req),
  });
  const deps: AssistantDeps = {
    chat,
    inputGuard: createInputGuard({ moderation, timeoutMs: 1000 }),
    outputGuard: createOutputGuard({ moderation, timeoutMs: 1000 }),
    newId: ids(),
    turnTimeoutMs: 5000,
    ...overrides,
  };
  return { deps, chat };
}

async function run(
  deps: AssistantDeps,
  message: string,
  signal = new AbortController().signal,
  conversationId?: string,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const e of createAssistant(deps).handleTurn(
    { message, requestId: 'req-1', conversationId },
    signal,
  )) {
    events.push(sseEventSchema.parse(e));
  }
  return events;
}

const types = (events: readonly SseEvent[]): string[] => events.map((e) => e.type);

describe('assistant turn', () => {
  it('streams moderated paragraphs between meta, status and done events', async () => {
    const { deps, chat } = setup();
    const events = await run(deps, 'Hello');
    expect(events).toEqual([
      {
        type: 'meta',
        conversationId: '00000000-0000-4000-8000-000000000001',
        messageId: '00000000-0000-4000-8000-000000000002',
      },
      { type: 'status', phase: 'moderating' },
      { type: 'status', phase: 'answering' },
      { type: 'delta', text: 'First paragraph.' },
      { type: 'delta', text: 'Second paragraph.' },
      { type: 'done', finishReason: 'stop' },
    ]);
    expect(chat.calls[0]?.options).toMatchObject({ numCtx: 8192, maxOutputTokens: 1200 });
    expect(chat.calls[0]?.messages).toEqual([
      { role: 'system', content: persona },
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('keeps the conversation id it was given', async () => {
    const { deps } = setup();
    const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const [meta] = await run(deps, 'Hi', undefined, id);
    expect(meta).toMatchObject({ type: 'meta', conversationId: id });
  });

  it('refuses flagged input without calling the chat model', async () => {
    const { deps, chat } = setup();
    const events = await run(deps, `please ${mockFlagMarkers.violent}`);
    expect(types(events)).toEqual(['meta', 'status', 'refusal', 'done']);
    expect(events[2]).toMatchObject({ kind: 'policy' });
    expect(events[3]).toEqual({ type: 'done', finishReason: 'refused' });
    expect(chat.calls).toHaveLength(0);
  });

  it('answers self-harm input with care and without the chat model', async () => {
    const { deps, chat } = setup();
    const events = await run(deps, mockFlagMarkers.selfHarm);
    expect(events[2]).toMatchObject({ type: 'refusal', kind: 'self_harm' });
    expect(chat.calls).toHaveLength(0);
  });

  it('fails closed when the guard is down', async () => {
    const { deps, chat } = setup(
      {},
      {
        classify: () => {
          throw new Error('down');
        },
      },
    );
    const events = await run(deps, 'Hello');
    expect(events[2]).toMatchObject({ type: 'refusal', kind: 'unavailable' });
    expect(chat.calls).toHaveLength(0);
  });

  it('stops at a flagged paragraph, keeping the paragraphs already released', async () => {
    let chatSignal: AbortSignal | undefined;
    const base = createMockChatProvider({
      reply: (req) => mockReply(`Fine.\n\n${mockFlagMarkers.violent}\n\nNever sent.`, req),
    });
    const { deps } = setup({
      chat: {
        chat: (req, signal) => {
          chatSignal = signal;
          return base.chat(req, signal);
        },
      },
    });
    const events = await run(deps, 'Hello');
    expect(types(events)).toEqual(['meta', 'status', 'status', 'delta', 'refusal', 'done']);
    expect(events[3]).toEqual({ type: 'delta', text: 'Fine.' });
    expect(events[5]).toEqual({ type: 'done', finishReason: 'refused' });
    expect(chatSignal?.aborted).toBe(true);
  });

  it('refuses a message over the user slot before calling the model', async () => {
    const { deps, chat } = setup();
    const code = '`' + 'x'.repeat(2400) + '`';
    expect(estimateTokens(code)).toBeGreaterThan(contextBudget.user);
    const events = await run(deps, code);
    expect(events.slice(-2)).toMatchObject([
      { type: 'error', code: 'bad_request', retryable: false },
      { type: 'done', finishReason: 'error' },
    ]);
    expect(chat.calls).toHaveLength(0);
  });

  it('reports a provider failure as a generic, retryable error', async () => {
    const { deps } = setup({
      chat: createMockChatProvider({
        reply: () => {
          throw new ProviderError('unavailable', 500);
        },
      }),
    });
    const events = await run(deps, 'Hello');
    expect(events.slice(-2)).toEqual([
      {
        type: 'error',
        code: 'model_unavailable',
        message: expect.any(String) as string,
        requestId: 'req-1',
        retryable: true,
      },
      { type: 'done', finishReason: 'error' },
    ]);
  });

  it('reports an unexpected failure as internal', async () => {
    const { deps } = setup({
      chat: createMockChatProvider({
        reply: () => {
          throw new Error('bug');
        },
      }),
    });
    const events = await run(deps, 'Hello');
    expect(events.at(-2)).toMatchObject({ code: 'internal' });
  });

  it('times out a slow turn', async () => {
    const { deps } = setup({
      chat: createMockChatProvider({ delayMs: 50 }),
      turnTimeoutMs: 20,
    });
    const events = await run(deps, 'Hello');
    expect(events.slice(-2)).toMatchObject([
      { type: 'error', code: 'timeout' },
      { type: 'done', finishReason: 'error' },
    ]);
  });

  it('stops quietly when the client goes away', async () => {
    const { deps } = setup({ chat: createMockChatProvider({ delayMs: 20 }) });
    const controller = new AbortController();
    const events: SseEvent[] = [];
    for await (const e of createAssistant(deps).handleTurn(
      { message: 'Hello', requestId: 'r' },
      controller.signal,
    )) {
      events.push(e);
      if (e.type === 'status' && e.phase === 'answering') controller.abort();
    }
    expect(types(events)).not.toContain('done');
    expect(types(events)).not.toContain('error');
  });

  it('reports a length finish', async () => {
    const { deps } = setup({
      chat: createMockChatProvider({
        reply: () => [
          { type: 'text', text: 'Cut off' },
          { type: 'done', finishReason: 'length', usage: { promptTokens: 1, outputTokens: 1 } },
        ],
      }),
    });
    const events = await run(deps, 'Hello');
    expect(events.slice(-2)).toEqual([
      { type: 'delta', text: 'Cut off' },
      { type: 'done', finishReason: 'length' },
    ]);
  });
});

describe('prompt budget', () => {
  it('estimates prose at 4 characters per token and code or URLs at 2', () => {
    expect(estimateTokens('abcd'.repeat(10))).toBe(10);
    expect(estimateTokens('`' + 'x'.repeat(38) + '`')).toBe(20);
    expect(estimateTokens('see https://example.com/a')).toBe(1 + 11);
  });

  it('keeps the persona inside the system slot', () => {
    expect(estimateTokens(persona)).toBeLessThanOrEqual(contextBudget.system);
  });

  it('sums the slots to the context window', () => {
    const { numCtx, ...slots } = contextBudget;
    expect(Object.values(slots).reduce((a, b) => a + b, 0)).toBe(numCtx);
  });

  it('refuses to build a prompt over the user slot', async () => {
    const guard = createInputGuard({ moderation: createMockModerationProvider(), timeoutMs: 1000 });
    const verdict = await guard.check('`' + 'x'.repeat(2400) + '`', new AbortController().signal);
    if (!verdict.ok) throw new Error('expected a pass');
    expect(buildMessages(verdict.text)).toBeUndefined();
  });
});
