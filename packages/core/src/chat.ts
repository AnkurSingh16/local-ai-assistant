export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** A tool call requested by the model. Arguments stay `unknown` until the tool's schema parses them. */
export interface ToolCall {
  readonly name: string;
  readonly arguments: unknown;
}

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  /** Present on assistant messages that requested tools. */
  readonly toolCalls?: readonly ToolCall[];
  /** Present on tool messages: the tool whose result this is. */
  readonly toolName?: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments, as the model sees it. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ChatOptions {
  /** Context window for the call. Always set explicitly so Ollama never truncates on its own (ADR-0004). */
  readonly numCtx: number;
  /** Upper bound on generated tokens. */
  readonly maxOutputTokens: number;
  readonly temperature?: number;
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly options: ChatOptions;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls';

export interface ChatUsage {
  readonly promptTokens: number;
  readonly outputTokens: number;
}

export type ChatChunk =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly call: ToolCall }
  | { readonly type: 'done'; readonly finishReason: FinishReason; readonly usage: ChatUsage };
