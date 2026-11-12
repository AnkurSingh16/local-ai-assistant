/**
 * Folding for rule matching only. The folded text is never shown, stored or
 * sent to a model; it exists so the rules see through common evasions: casing,
 * accents, look-alike letters from other scripts, leetspeak, punctuation or
 * spaces between letters, and stretched letters (ADR-0005).
 */

/**
 * Cyrillic and Greek letters that look like Latin ones. NFKC leaves these alone
 * because they are different letters, not compatibility forms.
 */
const confusables: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ɡ: 'g',
  ı: 'i',
  // Latin letters that NFD does not split into a base letter and a mark.
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  μ: 'u',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ω: 'w',
};

const leet: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'l',
  '+': 't',
};

export interface Folded {
  /** Lowercase Latin words separated by single spaces. */
  readonly spaced: string;
  /** The same letters with no spaces, for phrases written without them. */
  readonly squashed: string;
  readonly words: readonly string[];
}

/** Runs of three or more single letters, as in "i g n o r e", become one word. */
function joinSpelledOut(words: readonly string[]): string[] {
  const out: string[] = [];
  let run = '';
  const flush = (): void => {
    if (run.length >= 3) out.push(run);
    else out.push(...Array.from(run));
    run = '';
  };
  for (const word of words) {
    if (word.length === 1) {
      run += word;
    } else {
      flush();
      out.push(word);
    }
  }
  flush();
  return out;
}

export function fold(text: string): Folded {
  let mapped = '';
  for (const ch of text.toLowerCase()) mapped += confusables[ch] ?? leet[ch] ?? ch;
  const letters = mapped
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z]+/g, ' ')
    // Three or more of the same letter in a row is never English spelling.
    .replace(/([a-z])\1{2,}/g, '$1')
    .trim();
  const words = joinSpelledOut(letters === '' ? [] : letters.split(' '));
  return { spaced: words.join(' '), squashed: words.join(''), words };
}
