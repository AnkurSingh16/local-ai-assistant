import type { UntrustedWebText } from '@local-ai/core';
import { createRules, normalise } from '@local-ai/guardrails';

/**
 * The only place UntrustedWebText is minted (ADR-0002, ADR-0008). Search
 * snippets and page text reach a prompt only through here, as material to
 * cite, never as instructions. This reduces injection; the taint rule in the
 * agent loop (ADR-0003) is what bounds the damage if some gets through.
 */
export interface WebSource {
  /** The citation number the model and the user see. */
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly text: string;
}

export interface WrappedWeb {
  readonly text: UntrustedWebText;
  /** Sources kept, in order; their ids are the only valid citations. */
  readonly kept: readonly WebSource[];
  /** Sources dropped because they tripped the injection rules. */
  readonly dropped: readonly number[];
}

const injectionRules = createRules({ categories: ['injection'] });

/**
 * Anything that looks like our delimiter, opening or closing, with any spacing
 * or case: a page must not be able to close its own block and start talking.
 */
const delimiterLike = /<\s*\/?\s*web[\s_-]*content\b[^>]*>?/gi;

function clean(text: string): string {
  return normalise(text).replace(delimiterLike, '[removed]');
}

/** Attribute values hold no quotes, angle brackets or line breaks. */
function attribute(value: string): string {
  return clean(value)
    .replace(/["<>\n\r]/g, ' ')
    .trim();
}

function mint(text: string): UntrustedWebText {
  return text as UntrustedWebText;
}

/**
 * Wraps web sources for the prompt. `nonce` is random per request, injected by
 * the caller, so a page cannot guess the closing tag. Sources whose title or
 * text trip the injection rules are dropped whole.
 */
export function wrapWebContent(sources: readonly WebSource[], nonce: string): WrappedWeb {
  if (!/^[0-9a-f]{16,}$/.test(nonce)) throw new Error('nonce must be at least 16 hex characters');
  const kept: WebSource[] = [];
  const dropped: number[] = [];
  const blocks: string[] = [];
  for (const source of sources) {
    const text = clean(source.text);
    const title = attribute(source.title);
    if (injectionRules.check(text) !== undefined || injectionRules.check(title) !== undefined) {
      dropped.push(source.id);
      continue;
    }
    kept.push(source);
    blocks.push(
      `<web_content id="${String(source.id)}" nonce="${nonce}" url="${attribute(source.url)}" title="${title}">\n${text}\n</web_content nonce="${nonce}">`,
    );
  }
  return { text: mint(blocks.join('\n\n')), kept, dropped };
}
