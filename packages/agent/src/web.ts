import type { ToolCall, ToolDefinition, UntrustedWebText } from '@local-ai/core';
import type { ReadPage, WebSearch, WebSource } from '@local-ai/tools';
import { readPageDefinition, webSearchDefinition, wrapWebContent } from '@local-ai/tools';

import { contextBudget, estimateTokens } from './budget.js';
import { datetimeDefinition } from './datetime.js';

/** The web tools the agent may use; absent when the assistant runs without search. */
export interface WebTools {
  readonly search: WebSearch;
  readonly readPage: ReadPage;
  /** Random hex per request, so a page cannot guess the closing delimiter (ADR-0008). */
  readonly nonce: () => string;
}

/**
 * The taint rule (ADR-0003). A turn starts clean and may search once. After
 * search results are in context, only get_current_datetime and read_page on
 * this turn's result URLs are allowed; after page text, no further search.
 */
export interface TurnTaint {
  searched: boolean;
  pagesRead: number;
  readonly sources: Map<string, WebSource>;
}

export const maxPagesPerTurn = 2;

export function newTaint(): TurnTaint {
  return { searched: false, pagesRead: 0, sources: new Map() };
}

export function allowedTools(taint: TurnTaint): ToolDefinition[] {
  const tools: ToolDefinition[] = [datetimeDefinition];
  if (!taint.searched) tools.push(webSearchDefinition);
  else if (taint.pagesRead < maxPagesPerTurn && taint.sources.size > 0) {
    tools.push(readPageDefinition);
  }
  return tools;
}

export function isAllowed(call: ToolCall, taint: TurnTaint): boolean {
  return allowedTools(taint).some((t) => t.name === call.name);
}

/** Snippet and title lengths tried, longest first, before any result is dropped. */
const shortenings: readonly { readonly snippet: number; readonly title: number }[] = [
  { snippet: 500, title: 200 },
  { snippet: 300, title: 120 },
  { snippet: 180, title: 80 },
];

/**
 * Wraps search results to fit the snippet slot of the context budget
 * (ADR-0004): long snippets and titles are shortened first, so more results
 * fit, and only then are the last results dropped.
 */
export function wrapResults(
  results: readonly WebSource[],
  nonce: string,
): ReturnType<typeof wrapWebContent> {
  for (let n = results.length; n > 0; n--) {
    for (const s of shortenings) {
      const shortened = results
        .slice(0, n)
        .map((r) => ({ ...r, title: r.title.slice(0, s.title), text: r.text.slice(0, s.snippet) }));
      const wrapped = wrapWebContent(shortened, nonce);
      if (estimateTokens(wrapped.text) <= contextBudget.snippets) return wrapped;
    }
  }
  return wrapWebContent([], nonce);
}

/** Wraps one page, shortening its text until it fits half the page slot (two pages per turn). */
export function wrapPage(page: WebSource, nonce: string): ReturnType<typeof wrapWebContent> {
  const budget = contextBudget.pages / maxPagesPerTurn;
  let text = page.text;
  for (;;) {
    const wrapped = wrapWebContent([{ ...page, text }], nonce);
    if (estimateTokens(wrapped.text) <= budget || text.length < 200) return wrapped;
    text = text.slice(0, Math.floor(text.length * 0.8));
  }
}

/** A tool message's content: wrapped web content, or a short note written here. */
export type ToolResultContent = UntrustedWebText | string;
