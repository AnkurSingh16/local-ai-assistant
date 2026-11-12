/**
 * Decodes embedded base64, hex, percent-encoded and rot13 text so the rules can
 * inspect what it says. Decoded text is for inspection only: it never replaces
 * the message, and the model sees exactly what the user sent (ADR-0005).
 */

/** Bounds the work per message, whatever the input looks like. */
const maxRuns = 8;
const minRunChars = 16;

const base64Run = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const hexRun = /(?:[0-9a-fA-F]{2}[\s:]?){8,}/g;
const percentRun = /(?:%[0-9a-fA-F]{2}){4,}/g;

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Accepts bytes only when they are valid UTF-8 and mostly printable text. */
function asText(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return undefined;
  }
  if (text.length === 0) return undefined;
  const printable = text.replace(/[^\p{L}\p{N}\p{P}\p{Zs}\n\t]/gu, '').length;
  return printable / text.length >= 0.85 ? text : undefined;
}

function fromBase64(run: string): string | undefined {
  const standard = run.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (standard.length % 4 === 1) return undefined;
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return undefined;
  }
  return asText(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function fromHex(run: string): string | undefined {
  const digits = run.replace(/[\s:]/g, '');
  if (digits.length < minRunChars || digits.length % 2 !== 0) return undefined;
  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  return asText(bytes);
}

function fromPercent(run: string): string | undefined {
  try {
    return decodeURIComponent(run);
  } catch {
    return undefined;
  }
}

export function rot13(text: string): string {
  return text.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function decodeRuns(
  text: string,
  pattern: RegExp,
  decode: (run: string) => string | undefined,
): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(pattern)) {
    if (out.length >= maxRuns) break;
    const decoded = decode(match[0].trim());
    if (decoded !== undefined) out.push(decoded);
  }
  return out;
}

/** Every alternative reading of the text worth checking, not including the text itself. */
export function decodedViews(text: string): string[] {
  return [
    ...decodeRuns(text, base64Run, fromBase64),
    ...decodeRuns(text, hexRun, fromHex),
    ...decodeRuns(text, percentRun, fromPercent),
    rot13(text),
  ];
}
