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
  һ: 'h',
  ԍ: 'g',
  ѡ: 'w',
  ɩ: 'i',
  // Latin small capitals, which NFKC leaves alone.
  ᴀ: 'a',
  ʙ: 'b',
  ᴄ: 'c',
  ᴅ: 'd',
  ᴇ: 'e',
  ꜰ: 'f',
  ɢ: 'g',
  ʜ: 'h',
  ɪ: 'i',
  ᴊ: 'j',
  ᴋ: 'k',
  ʟ: 'l',
  ᴍ: 'm',
  ɴ: 'n',
  ᴏ: 'o',
  ᴘ: 'p',
  ʀ: 'r',
  ꜱ: 's',
  ᴛ: 't',
  ᴜ: 'u',
  ᴠ: 'v',
  ᴡ: 'w',
  ʏ: 'y',
  ᴢ: 'z',
};

/**
 * Digits and symbols used as letters. Applied in one folding and not in the
 * other, because "you idiot!" must still read as "idiot" while "1d10t" must
 * read as "idiot" too.
 */
const leet: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '2': 'z',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '6': 'g',
  '8': 'b',
  '9': 'g',
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
  /**
   * The letter runs of each whitespace-separated chunk, so "zor-blat" is one
   * chunk of two pieces while "go, ok" is two chunks. Joining pieces is only
   * safe inside a chunk; across whitespace it glues ordinary words together.
   */
  readonly chunks: readonly (readonly string[])[];
}

export interface FoldOptions {
  /** Read digits and symbols as the letters they imitate. */
  readonly leet: boolean;
  /**
   * How many letters a stretched run (three or more of one letter) collapses
   * to. One catches "stuuupid"; two catches a stretched word that has a real
   * double letter.
   */
  readonly stretch: 1 | 2;
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

const stripMarks = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '');

function foldChunk(chunk: string, options: FoldOptions): string[] {
  let latin = '';
  for (const ch of chunk) latin += confusables[ch] ?? ch;
  // A digit or symbol standing alone ("6 0 0 k") is a number or punctuation;
  // only read it as a letter inside a chunk that has letters ("1d10t").
  const useLeet = options.leet && /[a-z]/.test(stripMarks(latin));
  let mapped = '';
  for (const ch of latin) mapped += (useLeet ? leet[ch] : undefined) ?? ch;
  return stripMarks(mapped)
    .replace(/[^a-z]+/g, ' ')
    .replace(/([a-z])\1{2,}/g, options.stretch === 1 ? '$1' : '$1$1')
    .trim()
    .split(' ')
    .filter((piece) => piece !== '');
}

export function fold(text: string, options: FoldOptions): Folded {
  const chunks = text
    .toLowerCase()
    .split(/\s+/)
    .map((chunk) => foldChunk(chunk, options))
    .filter((pieces) => pieces.length > 0);
  const words = joinSpelledOut(chunks.flat());
  return { spaced: words.join(' '), squashed: words.join(''), words, chunks };
}

const options: readonly FoldOptions[] = [
  { leet: false, stretch: 1 },
  { leet: false, stretch: 2 },
  { leet: true, stretch: 1 },
  { leet: true, stretch: 2 },
];

/** Every distinct folding of the text; usually one or two, since most text folds the same way each time. */
export function foldings(text: string): Folded[] {
  const seen = new Map<string, Folded>();
  for (const o of options) {
    const folded = fold(text, o);
    const key = folded.chunks.map((c) => c.join('.')).join(' ');
    if (!seen.has(key)) seen.set(key, folded);
  }
  return [...seen.values()];
}
