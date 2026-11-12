/**
 * Characters that change how text is read or tokenised without being visible:
 * zero-width characters and joiners, the word joiner family, the byte-order mark,
 * bidi embedding, override and isolate controls, the soft hyphen, the combining
 * grapheme joiner, the Arabic letter mark, the Mongolian vowel separator, the
 * Hangul fillers, and Unicode tag characters, which can smuggle an invisible
 * instruction or split a word the rules look for (ADR-0005).
 */
const invisible =
  /\u034F|[\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u2060-\u2064\u3164\uFEFF\uFFA0\u202A-\u202E\u2066-\u2069]|\uDB40[\uDC00-\uDC7F]/g;

/**
 * Chat-template control tokens. Rewritten in every piece of non-system text so
 * user or web text cannot open a new turn or fake a tool call (ADR-0004).
 */
const templateToken = /<\|([^|<>\n]{0,64})\|>/g;
const toolCallTag = /<(\/?)(tool_call)>/gi;

export function neutraliseTemplateTokens(text: string): string {
  return text.replace(templateToken, '‹|$1|›').replace(toolCallTag, '‹$1$2›');
}

/** NFKC first, so compatibility forms of the stripped characters are caught too. */
export function normalise(text: string): string {
  return neutraliseTemplateTokens(text.normalize('NFKC').replace(invisible, ''));
}
