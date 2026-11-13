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
 * Delimiter look-alikes. The nonce is what stops a page forging the end of its
 * block, since a page cannot know it; removing look-alikes is a second, best
 * effort layer. Only tag-shaped text is removed (after an opening bracket, or
 * a slash as in a closing tag), so ordinary prose about "web content", WCAG or
 * Electron's webContents is left alone. Separators and a few Cyrillic
 * look-alike letters are allowed between the parts; every repeat is bounded,
 * so the patterns stay linear.
 */
const word = '[wW][eEеЕ][bB][^a-zA-Z0-9>›\n]{0,6}[cCсС][oOоО0][nN][tT][eEеЕ][nN][tT]';
const delimiterTag = new RegExp(
  `(?:<|‹|&lt;)[\\s/]{0,8}${word}[\\w-]{0,12}[^>›\\n]{0,200}(?:>|›|&gt;)?`,
  'g',
);
// A closing tag missing its bracket, but not a URL path such as /webcontent/guide.
const closingWithoutBracket = new RegExp(`\\/${word}[\\w-]{0,12}(?=[\\s>\u203A]|$)`, 'gm');

function removeLookalikes(text: string, replacement: string): string {
  return text.replace(delimiterTag, replacement).replace(closingWithoutBracket, replacement);
}

/** Text with look-alike delimiters replaced, for the prompt. */
function clean(text: string): string {
  return removeLookalikes(normalise(text), '[removed]');
}

/**
 * Text with look-alikes deleted outright, for the injection check only: a page
 * could otherwise split "ign<web_content>ore" so the check sees two halves.
 */
function joined(text: string): string {
  return removeLookalikes(normalise(text), '');
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
