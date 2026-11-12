/**
 * Characters that change how text is read or tokenised without being visible:
 * zero-width characters and joiners, the word joiner family, the byte-order mark,
 * bidi embedding, override and isolate controls, and Unicode tag characters,
 * which can smuggle an invisible instruction (ADR-0005).
 */
const invisible =
  /[\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]|\uDB40[\uDC00-\uDC7F]/g;

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
