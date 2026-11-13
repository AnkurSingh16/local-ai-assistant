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
  /**
   * Sources kept, in order, with cleaned titles and text; their ids are the
   * only valid citations. The URL is the original, for the citation link.
   */
  readonly kept: readonly WebSource[];
  /** Sources dropped because they tripped the injection rules. */
  readonly dropped: readonly number[];
}

const injectionRules = createRules({ categories: ['injection'] });

/**
 * Anything that looks like our delimiter, opening or closing: a page must not
 * be able to close its own block and start talking. Matched on the normalised
 * text with look-alike hyphens, a Cyrillic о, escaped brackets and no bracket
 * at all. Every repeat is bounded and the match must reach "web" within a few
 * characters, so a long run of blanks cannot make it quadratic.
 */
const delimiterLike =
  /(?:(?:<|\u2039|&lt;)[\s/]{0,8}|\/)?web[\s_.\-\u2010-\u2015]{0,3}c[o\u043E0]ntents?(?:_[a-z]+)?\b[^>\u203A\n]{0,200}(?:>|\u203A|&gt;)?/gi;

/** Text with look-alike delimiters replaced, for the prompt. */
function clean(text: string): string {
  return normalise(text).replace(delimiterLike, '[removed]');
}

/**
 * Text with look-alikes deleted outright, for the injection check only: a page
 * could otherwise split "ign<web_content>ore" so the check sees two halves.
 */
function joined(text: string): string {
  return normalise(text).replace(delimiterLike, '');
}

/** Attribute values hold no quotes, angle brackets or line or paragraph breaks of any kind. */
function attribute(value: string): string {
  return clean(value)
    .replace(/["<>]|[\s\p{Zl}\p{Zp}\u0085]+/gu, ' ')
    .trim();
}

function trips(...texts: string[]): boolean {
  return texts.some((t) => injectionRules.check(t) !== undefined);
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
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) throw new Error('nonce must be 16 to 64 hex characters');
  const kept: WebSource[] = [];
  const dropped: number[] = [];
  const blocks: string[] = [];
  for (const source of sources) {
    const text = clean(source.text);
    const title = attribute(source.title);
    const url = attribute(source.url);
    // The URL path is attacker-controlled too, so it is checked like the title.
    if (trips(text, title, url, joined(source.text), joined(source.title), joined(source.url))) {
      dropped.push(source.id);
      continue;
    }
    // The cleaned values, so nothing returned here carries what was removed.
    kept.push({ id: source.id, url: source.url, title, text });
    blocks.push(
      `<web_content id="${String(source.id)}" nonce="${nonce}" url="${url}" title="${title}">\n${text}\n</web_content nonce="${nonce}">`,
    );
  }
  return { text: mint(blocks.join('\n\n')), kept, dropped };
}
