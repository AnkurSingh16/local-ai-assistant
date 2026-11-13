import type { WebTools } from '@local-ai/agent';
import { createAssistant, leakCheckPrompt, personaCanary } from '@local-ai/agent';
import type { RefusalKind } from '@local-ai/contract';
import type { ChatProvider, ModerationProvider } from '@local-ai/core';
import { createManualClock } from '@local-ai/core';
import { createInputGuard, createOutputGuard, createOutputRules } from '@local-ai/guardrails';

/** What one turn did, as the scorer needs it. */
export interface TurnOutcome {
  readonly chatCalled: boolean;
  readonly refusal: RefusalKind | undefined;
  /** Paragraphs released to the user, in order. */
  readonly released: readonly string[];
  readonly error: string | undefined;
}

export interface PipelineProviders {
  readonly chat: ChatProvider;
  readonly moderation: ModerationProvider;
}

/**
 * Web tools as production offers them, so every case runs with the production
 * system prompt (persona and web guide) and tool definitions. Search finds
 * nothing and pages cannot be read: the red-team set tests the model and the
 * guards, and must never depend on the internet.
 */
const offlineWeb: WebTools = {
  search: { run: () => Promise.resolve({ ok: true, query: '', results: [] }) },
  readPage: { run: () => Promise.resolve({ ok: false, error: 'not_allowed' }) },
  nonce: () => '0123456789abcdef0123',
};

/** A fixed date, so the router decides the same way on every run. */
const evalDate = new Date('2026-11-13T12:00:00Z');

/**
 * Runs one turn through the same assistant, guards and rules the API uses, with
 * the given providers. Only the providers differ between replay and live runs.
 */
export async function runTurn(
  providers: PipelineProviders,
  message: string,
  timeouts: { readonly guardMs: number; readonly turnMs: number },
): Promise<TurnOutcome> {
  let chatCalled = false;
  const chat: ChatProvider = {
    chat(req, signal) {
      chatCalled = true;
      return providers.chat.chat(req, signal);
    },
  };
  const guard = { moderation: providers.moderation, timeoutMs: timeouts.guardMs };
  let ids = 0;
  const assistant = createAssistant({
    chat,
    inputGuard: createInputGuard(guard),
    outputGuard: createOutputGuard({
      ...guard,
      rules: createOutputRules({ systemPrompt: leakCheckPrompt, canary: personaCanary }),
    }),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    turnTimeoutMs: timeouts.turnMs,
    clock: createManualClock(evalDate),
    web: offlineWeb,
    temperature: 0,
  });

  const released: string[] = [];
  let refusal: RefusalKind | undefined;
  let error: string | undefined;
  for await (const event of assistant.handleTurn(
    { message, requestId: 'eval' },
    new AbortController().signal,
  )) {
    if (event.type === 'delta') released.push(event.text);
    else if (event.type === 'refusal') refusal = event.kind;
    else if (event.type === 'error') error = event.code;
  }
  return { chatCalled, refusal, released, error };
}
