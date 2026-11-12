/**
 * Decodes embedded encodings so the rules can inspect what they say: base64
 * (including url-safe and line-wrapped), hex, percent-encoding, `\x`, `\u`,
 * `0x` and HTML character escapes, and rot13, two layers deep. Decoded text is
 * for inspection only: it never replaces the message, and the model sees
 * exactly what the user sent (ADR-0005).
 *
 * Each layer returns a fixed number of views, each no longer than its input,
 * so the work stays proportional to the message size whatever it contains.
 */

/** Short enough for one encoded word: 6 bytes is 8 base64 characters or 12 hex digits. */
const minBase64Chars = 8;
const minHexDigits = 8;

const base64Run = /[A-Za-z0-9+/_-]+={0,2}/g;
/**
 * Base64 is often wrapped at 64 or 76 characters. Lines are rejoined only after
 * a long run, so ordinary words at line ends are not glued together.
 */
const wrappedBase64Break = /(?<=[A-Za-z0-9+/_-]{16})\r?\n(?=[A-Za-z0-9+/_-])/g;
const hexRun = /(?:[0-9a-fA-F]{2}[\s:]?){4,}/g;

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
  const printable = text.replace(/[^\p{L}\p{N}\p{P}\p{S}\p{Zs}\n\t]/gu, '').length;
  return printable / text.length >= 0.85 ? text : undefined;
}

function fromBase64(run: string): string | undefined {
  const standard = run.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (standard.length < minBase64Chars || standard.length % 4 === 1) return undefined;
  // Ordinary words are valid base64 too; only mixed-looking runs are worth decoding.
  if (/^[a-z]+$/.test(standard) || /^[A-Z][a-z]+$/.test(standard)) return undefined;
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
  if (digits.length < minHexDigits || digits.length % 2 !== 0) return undefined;
  // A run of decimal digits is a number, not hex.
  if (/^\d+$/.test(digits)) return undefined;
  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  return asText(bytes);
}

/** Replaces each decodable run in place, so a partly encoded word is rejoined. */
function replaceRuns(
  text: string,
  pattern: RegExp,
  decode: (run: string) => string | undefined,
): string {
  return text.replace(pattern, (run) => {
    const decoded = decode(run.trim());
    return decoded === undefined ? run : ` ${decoded} `;
  });
}

function fromCodePoint(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** Percent, `\x`, `\u`, `0x` and HTML escapes, decoded in place. */
export function unescapeAll(text: string): string {
  return text
    .replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    })
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => fromCodePoint(parseInt(h, 16)))
    .replace(/\\u\{?([0-9a-fA-F]{4,6})\}?/g, (_, h: string) => fromCodePoint(parseInt(h, 16)))
    .replace(/\b0x([0-9a-fA-F]{2})\b/g, (_, h: string) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]{1,6});?/g, (_, h: string) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});?/g, (_, d: string) => fromCodePoint(parseInt(d, 10)));
}

export function rot13(text: string): string {
  return text.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function decodeOnce(text: string): string[] {
  return [
    unescapeAll(text),
    replaceRuns(
      replaceRuns(text.replace(wrappedBase64Break, ''), base64Run, fromBase64),
      hexRun,
      fromHex,
    ),
    rot13(text),
  ];
}

/**
 * Alternative readings of the text, not including the text itself: one layer
 * of each decoding, then each decoding again on those results, so base64 of
 * rot13 and similar stacks are seen too. Duplicates are dropped.
 */
export function decodedViews(text: string): string[] {
  const first = decodeOnce(text);
  const all = new Set([...first, ...first.flatMap(decodeOnce)]);
  all.delete(text);
  return [...all];
}
