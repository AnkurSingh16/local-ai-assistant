import type { ChatMessage, ChatProvider, Clock, ModeratedText, ToolCall } from '@local-ai/core';
import { isAbortError, ProviderError } from '@local-ai/core';
import type { FinishReason, SseEvent, StatusPhase } from '@local-ai/contract';
import type { InputGuard, OutputGuard } from '@local-ai/guardrails';
import {
  createParagraphSplitter,
  neutraliseTemplateTokens,
  refusalMessages,
} from '@local-ai/guardrails';

import { persona, webGuide } from '../persona/persona.js';
import { contextBudget, estimateTokens, maxPromptTokens, promptTokens } from './budget.js';
import { citationsIn, keepListedLinks } from './links.js';
import { isTimeSensitive } from './routing.js';
import { runToolCalls, writeQuery } from './steps.js';
import type { WebTools } from './web.js';
import { allowedTools, newTaint } from './web.js';

export interface AssistantDeps {
  readonly chat: ChatProvider;
  readonly inputGuard: InputGuard;
  readonly outputGuard: OutputGuard;
  /** Random UUIDs, injected so tests are deterministic. */
  readonly newId: () => string;
  /** Upper bound on a whole turn (ADR-0003). */
  readonly turnTimeoutMs: number;
  readonly temperature?: number;
  /** For get_current_datetime and the router's sense of the current year. */
  readonly clock: Clock;
  /** Web search and page reading; without them the assistant answers from the model alone. */
  readonly web?: WebTools;
  /** Conversation history for turns that are remembered (a session is present). */
  readonly conversations?: ConversationStore;
  /** Approved memory for the session; only items the owner approved are ever returned. */
  readonly memory?: MemoryRecall;
}

/** Items the owner approved for this session that relate to the message (ADR-0009). */
export interface MemoryRecall {
  recall(sessionId: string, message: string, signal: AbortSignal): Promise<string[]>;
  /**
   * Every approved item for the session. Search queries are checked against all
   * of them, since an earlier answer in the history may repeat one that was not
   * recalled this turn (ADR-0003).
   */
  all(sessionId: string): Promise<string[]>;
}

/**
 * Where remembered turns are kept. It takes only moderated text, so nothing a
 * guard refused can be stored (ADR-0002, ADR-0005 step 9).
 */
export interface ConversationStore {
  recent(
    conversationId: string,
    limit: number,
  ): Promise<{ role: 'user' | 'assistant'; content: string }[]>;
  append(
    conversationId: string,
    role: 'user' | 'assistant',
    parts: readonly ModeratedText[],
  ): Promise<void>;
}

/** How many stored messages are considered before fitting them to the history budget. */
const historyLookback = 40;

/** ADR-0003: four model steps per turn, the forced-query step included. */
export const maxModelSteps = 4;

export interface TurnInput {
  readonly message: string;
  readonly conversationId?: string | undefined;
  /** Correlates the error event with the API's request log. */
  readonly requestId: string;
  /** Load and store history for this conversation; the route sets it only for a claimed conversation. */
  readonly remember?: boolean;
  /** The session the turn belongs to, for approved memory. */
  readonly sessionId?: string;
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
export function buildMessages(
  user: ModeratedText,
  withWeb = false,
  history: readonly { role: 'user' | 'assistant'; content: string }[] = [],
  memory: readonly string[] = [],
): ChatMessage[] | undefined {
  const system = withWeb ? `${persona}\n\n${webGuide}` : persona;
  if (estimateTokens(system) > contextBudget.system) return undefined;
  if (estimateTokens(user) > contextBudget.user) return undefined;
  // The newest turns that fit the history slot; the oldest are dropped first (ADR-0004).
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m === undefined) continue;
    const cost = estimateTokens(m.content) + 4;
    if (used + cost > contextBudget.history) break;
    used += cost;
    // Stored text was moderated, but an answer can spell out chat-template
    // tokens; replayed raw, they would forge a system turn (ADR-0004).
    kept.unshift({ role: m.role, content: neutraliseTemplateTokens(m.content) });
  }
  // Approved memory fills its own slot and never displaces history. Recall puts
  // always-on items first (ADR-0001 amendment of 2026-11-14), then the most
  // similar. An item that does not fit is skipped rather than ending the list,
  // so one long item cannot hide a short always-on one after it.
  const remembered: string[] = [];
  let memoryUsed = 0;
  for (const item of memory) {
    const cost = estimateTokens(item) + 2;
    if (memoryUsed + cost > contextBudget.memory) continue;
    memoryUsed += cost;
    remembered.push(`- ${neutraliseTemplateTokens(item)}`);
  }
  const memoryMessage: ChatMessage[] =
    remembered.length === 0
      ? []
      : [
          {
            role: 'system',
            content: `Things this user asked you to remember, reviewed and approved:\n${remembered.join('\n')}`,
          },
        ];
  return [
    { role: 'system', content: system },
    ...memoryMessage,
    ...kept,
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

        const web = deps.web;
        const store = input.remember === true ? deps.conversations : undefined;
        const history =
          store === undefined ? [] : await store.recent(conversationId, historyLookback);
        // Only approved items come back, and only for this session (ADR-0009).
        const recalled =
          deps.memory === undefined || input.sessionId === undefined
            ? []
            : await deps.memory.recall(input.sessionId, verdict.text, signal);
        const approved =
          deps.memory === undefined || input.sessionId === undefined
            ? []
            : await deps.memory.all(input.sessionId);
        const messages = buildMessages(verdict.text, web !== undefined, history, recalled);
        if (messages === undefined) {
          yield error('bad_request', false);
          yield done('error');
          return;
        }
        await store?.append(conversationId, 'user', [verdict.text]);
        // Released paragraphs only: text a guard withheld is never stored.
        const released: ModeratedText[] = [];

        // Generation and moderation run side by side (ADR-0005): a pump reads the
        // model stream into the hold-back buffer while this loop checks and
        // releases units in order. The pump never yields to the client itself.
        const splitter = createParagraphSplitter();
        // Units of the answer and status changes, in order; the pump fills it.
        const pending: ({ kind: 'unit'; text: string } | { kind: 'status'; phase: StatusPhase })[] =
          [];
        // Shared with the pump; an object so the compiler does not narrow it away.
        const pumpState: {
          done: boolean;
          failed: boolean;
          error: unknown;
          finish: FinishReason;
        } = {
          done: false,
          failed: false,
          error: undefined,
          finish: 'stop',
        };
        let wake: (() => void) | undefined;
        const notify = (): void => {
          wake?.();
          wake = undefined;
        };
        const taint = newTaint();
        let lastPhase: StatusPhase | undefined;
        const status = (phase: StatusPhase): void => {
          // The forced path announces searching before writing the query; the search itself need not repeat it.
          if (phase === lastPhase) return;
          lastPhase = phase;
          pending.push({ kind: 'status', phase });
          notify();
        };
        const pushUnits = (units: readonly string[]): void => {
          for (const text of units) pending.push({ kind: 'unit', text });
          notify();
        };

        /** One model step: streams text into the splitter, collects tool calls. */
        const step = async (offerTools: boolean): Promise<readonly ToolCall[]> => {
          const calls: ToolCall[] = [];
          let wroteText = false;
          const tools = offerTools ? allowedTools(taint) : undefined;
          if (promptTokens(messages, tools) > maxPromptTokens) {
            throw new Error('the prompt is over the context budget');
          }
          const stream = deps.chat.chat(
            {
              messages,
              ...(tools === undefined ? {} : { tools }),
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
              if (chunk.text.trim() !== '' || wroteText) {
                if (!wroteText) status('answering');
                wroteText = true;
                pushUnits(splitter.push(chunk.text));
              }
            } else if (chunk.type === 'tool_call') {
              calls.push(chunk.call);
            } else {
              pumpState.finish = chunk.finishReason === 'length' ? 'length' : 'stop';
            }
          }
          // Once the model has started answering, the step is the answer: tool
          // calls after text are ignored rather than half-releasing a reply.
          return wroteText ? [] : calls;
        };

        const pump = (async () => {
          try {
            let steps = 0;
            if (web !== undefined && isTimeSensitive(verdict.text, deps.clock.now())) {
              status('searching');
              steps += 1;
              const query = await writeQuery(deps.chat, verdict.text, signal);
              const call = { name: 'web_search', arguments: { query: query ?? '' } };
              await runToolCalls(
                { web, clock: deps.clock, taint, messages, status, signal, privateText: approved },
                [call],
              );
            }
            for (;;) {
              steps += 1;
              const offerTools = web !== undefined && steps < maxModelSteps;
              const calls = await step(offerTools);
              // Tool calls on a step that was offered no tools are ignored, so the
              // step budget is a hard stop even if the model keeps asking.
              if (calls.length === 0 || web === undefined || !offerTools) break;
              await runToolCalls(
                { web, clock: deps.clock, taint, messages, status, signal, privateText: approved },
                calls,
              );
            }
            pushUnits(splitter.flush());
          } catch (err) {
            pumpState.failed = true;
            pumpState.error = err;
          } finally {
            pumpState.done = true;
            notify();
          }
        })();

        try {
          const cited = new Set<number>();
          for (;;) {
            const item = pending.shift();
            if (item === undefined) {
              if (pumpState.done) break;
              // Safe: the check above and setting wake below happen in the same tick.
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              continue;
            }
            if (item.kind === 'status') {
              yield { type: 'status', phase: item.phase };
              continue;
            }
            const sources = [...taint.sources.values()];
            const unit = keepListedLinks(item.text, new Set(sources.map((s) => s.url)));
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
            released.push(checked.text);
            yield { type: 'delta', text: checked.text };
            // A citation is sent only after the paragraph that cites it is released (ADR-0005).
            // [n] markers, and links straight to a listed source, both count as citing it.
            const linked = sources.filter((s) => checked.text.includes(s.url)).map((s) => s.id);
            for (const n of [...citationsIn(checked.text), ...linked]) {
              const source = sources.find((s) => s.id === n);
              if (source === undefined || cited.has(n)) continue;
              cited.add(n);
              yield { type: 'citation', n, url: source.url, title: source.title.slice(0, 300) };
            }
          }
          if (pumpState.failed) {
            throw pumpState.error instanceof Error
              ? pumpState.error
              : new Error('chat stream failed');
          }
          if (released.length === 0) {
            // The model spent every step on tool calls, or wrote nothing: an
            // empty answer would look like success, so it is reported instead.
            yield error('internal', true);
            yield done('error');
            return;
          }
          yield done(pumpState.finish);
        } finally {
          // Stops generation on a refusal, an error or an early exit, and waits
          // for the pump so nothing keeps running after the turn.
          stop.abort();
          await pump;
          if (store !== undefined && released.length > 0) {
            await store.append(conversationId, 'assistant', released);
          }
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
