import type {
  ChatChunk,
  ChatMessage,
  ChatProvider,
  ChatRequest,
  FinishReason,
  ToolDefinition,
} from '@local-ai/core';
import { ProviderError } from '@local-ai/core';
import { z } from 'zod';

import type { FetchFn } from './http.js';
import { parseJsonLine, postJson } from './http.js';
import { readLines } from './ndjson.js';

export interface OllamaChatConfig {
  /** For example http://127.0.0.1:11434. */
  readonly baseUrl: string;
  readonly model: string;
  /** How long Ollama keeps the model loaded after a call, for example "30m". */
  readonly keepAlive: string;
  readonly fetch: FetchFn;
}

const streamLineSchema = z.union([
  z.object({ error: z.string() }),
  z.object({
    message: z
      .object({
        content: z.string().default(''),
        tool_calls: z
          .array(z.object({ function: z.object({ name: z.string(), arguments: z.unknown() }) }))
          .optional(),
      })
      .optional(),
    done: z.boolean(),
    done_reason: z.string().optional(),
    prompt_eval_count: z.number().int().nonnegative().optional(),
    eval_count: z.number().int().nonnegative().optional(),
  }),
]);

function toOllamaMessage(m: ChatMessage): Record<string, unknown> {
  return {
    role: m.role,
    content: m.content,
    ...(m.toolCalls === undefined
      ? {}
      : {
          tool_calls: m.toolCalls.map((c) => ({
            function: { name: c.name, arguments: c.arguments },
          })),
        }),
    ...(m.toolName === undefined ? {} : { tool_name: m.toolName }),
  };
}

function toOllamaTool(t: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

export function createOllamaChatProvider(config: OllamaChatConfig): ChatProvider {
  const url = new URL('/api/chat', config.baseUrl).toString();
  return {
    async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
      const body = {
        model: config.model,
        messages: req.messages.map(toOllamaMessage),
        ...(req.tools === undefined ? {} : { tools: req.tools.map(toOllamaTool) }),
        stream: true,
        keep_alive: config.keepAlive,
        options: {
          // Always explicit: Ollama silently drops the start of an over-long prompt otherwise (ADR-0004).
          num_ctx: req.options.numCtx,
          num_predict: req.options.maxOutputTokens,
          ...(req.options.temperature === undefined
            ? {}
            : { temperature: req.options.temperature }),
        },
      };
      const res = await postJson(config.fetch, url, body, signal);
      if (res.body === null) throw new ProviderError('bad_response', res.status);

      let sawToolCall = false;
      for await (const line of readLines(res.body, signal)) {
        const parsed = streamLineSchema.safeParse(parseJsonLine(line));
        if (!parsed.success) throw new ProviderError('bad_response');
        const data = parsed.data;
        if ('error' in data) throw new ProviderError('unavailable');

        if (data.message !== undefined) {
          if (data.message.content !== '') yield { type: 'text', text: data.message.content };
          for (const call of data.message.tool_calls ?? []) {
            sawToolCall = true;
            yield {
              type: 'tool_call',
              call: { name: call.function.name, arguments: call.function.arguments },
            };
          }
        }
        if (data.done) {
          // Ollama reports "stop" even when the model called a tool.
          const finishReason: FinishReason =
            data.done_reason === 'length' ? 'length' : sawToolCall ? 'tool_calls' : 'stop';
          yield {
            type: 'done',
            finishReason,
            usage: {
              promptTokens: data.prompt_eval_count ?? 0,
              outputTokens: data.eval_count ?? 0,
            },
          };
          return;
        }
      }
      // The stream closed without a done line: the server went away mid-answer.
      throw new ProviderError('unavailable');
    },
  };
}
