import type { ChatMessage, ChatProvider, ModeratedText } from '@local-ai/core';
import { isAbortError, ProviderError } from '@local-ai/core';
import type { FinishReason, SseEvent } from '@local-ai/contract';
import type { InputGuard, OutputGuard } from '@local-ai/guardrails';
import { createParagraphSplitter, refusalMessages } from '@local-ai/guardrails';

import { persona } from '../persona/persona.js';
import { contextBudget, estimateTokens } from './budget.js';

export interface AssistantDeps {
  readonly chat: ChatProvider;
  readonly inputGuard: InputGuard;
  readonly outputGuard: OutputGuard;
  /** Random UUIDs, injected so tests are deterministic. */
  readonly newId: () => string;
  /** Upper bound on a whole turn (ADR-0003). */
  readonly turnTimeoutMs: number;
  readonly temperature?: number;
}

export interface TurnInput {
  readonly message: string;
  readonly conversationId?: string | undefined;
  /** Correlates the error event with the API's request log. */
  readonly requestId: string;
}

export interface Assistant {
  /**
   * Runs one turn and yields its SSE events. The stream always ends with a
   * `done` event, unless the caller aborts, in which case it simply stops.
   */
  handleTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<SseEvent>;
}

const genericErrors = {
  model_unavailable: 'The assistant is not available right now. Please try again shortly.',
  timeout: 'That took too long to answer. Please try again.',
  internal: 'Something went wrong. Please try again.',
  bad_request: 'That message is too long. Please shorten it and try again.',
} as const;

/** Builds the prompt. The user slot accepts only text that passed the input guard. */
export function buildMessages(user: ModeratedText): ChatMessage[] | undefined {
  if (estimateTokens(persona) > contextBudget.system) return undefined;
  if (estimateTokens(user) > contextBudget.user) return undefined;
  return [
    { role: 'system', content: persona },
    { role: 'user', content: user },
  ];
}

export function createAssistant(deps: AssistantDeps): Assistant {
  return {
    async *handleTurn(input: TurnInput, clientSignal: AbortSignal): AsyncIterable<SseEvent> {
      const conversationId = input.conversationId ?? deps.newId();
      const messageId = deps.newId();
      // Lets an output refusal stop generation without touching the client's signal.
      const stop = new AbortController();
      const signal = AbortSignal.any([
        clientSignal,
        stop.signal,
        AbortSignal.timeout(deps.turnTimeoutMs),
      ]);

      const error = (code: keyof typeof genericErrors, retryable: boolean): SseEvent => ({
        type: 'error',
        code,
        message: genericErrors[code],
        requestId: input.requestId,
        retryable,
      });
      const done = (finishReason: FinishReason): SseEvent => ({ type: 'done', finishReason });

      yield { type: 'meta', conversationId, messageId };
      yield { type: 'status', phase: 'moderating' };

      try {
        const verdict = await deps.inputGuard.check(input.message, signal);
        if (!verdict.ok) {
          if ('tooLong' in verdict) {
            yield error('bad_request', false);
            yield done('error');
            return;
          }
          yield {
            type: 'refusal',
            kind: verdict.refusal,
            message: refusalMessages[verdict.refusal],
          };
          yield done('refused');
          return;
        }

        const messages = buildMessages(verdict.text);
        if (messages === undefined) {
          yield error('bad_request', false);
          yield done('error');
          return;
        }

        yield { type: 'status', phase: 'answering' };

        // Generation and moderation run side by side (ADR-0005): a pump reads the
        // model stream into the hold-back buffer while this loop checks and
        // releases units in order. The pump never yields to the client itself.
        const splitter = createParagraphSplitter();
        const pending: string[] = [];
        // Shared with the pump; an object so the compiler does not narrow it away.
        const pumpState: { done: boolean; error: unknown; finish: FinishReason } = {
          done: false,
          error: undefined,
          finish: 'stop',
        };
        let wake: (() => void) | undefined;
        const notify = (): void => {
          wake?.();
          wake = undefined;
        };
        const pump = (async () => {
          try {
            const stream = deps.chat.chat(
              {
                messages,
                options: {
                  numCtx: contextBudget.numCtx,
                  maxOutputTokens: contextBudget.output,
                  ...(deps.temperature === undefined ? {} : { temperature: deps.temperature }),
                },
              },
              signal,
            );
            for await (const chunk of stream) {
              if (chunk.type === 'text') {
                pending.push(...splitter.push(chunk.text));
                notify();
              } else if (chunk.type === 'done') {
                pumpState.finish = chunk.finishReason === 'length' ? 'length' : 'stop';
              }
              // No tools are offered yet, so tool_call chunks are ignored.
            }
            pending.push(...splitter.flush());
          } catch (err) {
            pumpState.error = err;
          } finally {
            pumpState.done = true;
            notify();
          }
        })();

        try {
          for (;;) {
            const unit = pending.shift();
            if (unit === undefined) {
              if (pumpState.done) break;
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              continue;
            }
            const checked = await deps.outputGuard.checkParagraph(unit, signal);
            if (!checked.ok) {
              yield {
                type: 'refusal',
                kind: checked.refusal,
                message: refusalMessages[checked.refusal],
              };
              yield done('refused');
              return;
            }
            yield { type: 'delta', text: checked.text };
          }
          if (pumpState.error !== undefined) {
            throw pumpState.error instanceof Error
              ? pumpState.error
              : new Error('chat stream failed');
          }
          yield done(pumpState.finish);
        } finally {
          // Stops generation on a refusal, an error or an early exit, and waits
          // for the pump so nothing keeps running after the turn.
          stop.abort();
          await pump;
        }
      } catch (err) {
        if (clientSignal.aborted) return;
        if (isAbortError(err)) {
          yield error('timeout', true);
        } else if (err instanceof ProviderError) {
          yield error('model_unavailable', true);
        } else {
          yield error('internal', true);
        }
        yield done('error');
      }
    },
  };
}
