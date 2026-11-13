import type { ChatMessage, ToolDefinition } from '@local-ai/core';

/**
 * Context budget (ADR-0004). Every chat call uses the same num_ctx, and the
 * prompt is refused before it reaches Ollama if the estimate exceeds a slot,
 * so Ollama never truncates on its own.
 */
export const contextBudget = {
  numCtx: 8192,
  system: 1000,
  memory: 400,
  history: 1800,
  user: 1000,
  snippets: 600,
  pages: 2000,
  output: 1200,
  overhead: 192,
} as const;

const denseRuns = /https?:\/\/\S+|```[\s\S]*?(```|$)|`[^`\n]+`/g;

/**
 * Conservative token estimate from characters: 4 characters per token for
 * prose and 2 for URLs and code (measured on qwen2.5:7b at 5.03 and 2.35).
 */
export function estimateTokens(text: string): number {
  let dense = 0;
  for (const match of text.matchAll(denseRuns)) dense += match[0].length;
  const prose = text.length - dense;
  return Math.ceil(prose / 4) + Math.ceil(dense / 2);
}

/** Per-message framing the chat template adds (role markers), counted generously. */
const perMessageTokens = 8;

/**
 * The whole prompt of one model step: every message, any tool calls the model
 * made, and the tool definitions offered. Checked before every step, because
 * tool results and tool-call messages grow the prompt after the slots were
 * checked (ADR-0004: never rely on Ollama to truncate).
 */
export function promptTokens(
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[] | undefined,
): number {
  let total = tools === undefined || tools.length === 0 ? 0 : estimateTokens(JSON.stringify(tools));
  for (const m of messages) {
    total += perMessageTokens + estimateTokens(m.content);
    if (m.toolCalls !== undefined) total += estimateTokens(JSON.stringify(m.toolCalls));
  }
  return total;
}

/** The most a prompt may use, leaving room for the answer. */
export const maxPromptTokens = contextBudget.numCtx - contextBudget.output;
