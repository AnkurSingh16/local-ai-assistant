import { createHash } from 'node:crypto';

import { normalise } from '../normalise.js';
import { decodedViews } from './decode.js';
import type { Folded } from './fold.js';
import { hasFakeTurn, hasInjection } from './injection.js';
import { foldings } from './fold.js';
import { slurHashes as defaultSlurHashes } from './slurs.js';

/**
 * The deterministic rules baseline (ADR-0005, step 4). It runs before the
 * classifier because it is cheap and covers what llama-guard3 does not claim to
 * catch reliably: slurs, abuse aimed at the assistant, unambiguous sexual
 * content involving minors, jailbreak and injection phrases, and secrets or
 * identifiers that must never be stored. Broader and contextual cases are left
 * to the classifier, so these rules stay narrow enough not to refuse most
 * ordinary questions.
 *
 * Every pattern here is linear: no nested or overlapping repetition, because the
 * check runs synchronously on the event loop where no timeout can stop it.
 */
export type RuleCategory = 'slur' | 'sexual_minors' | 'abuse' | 'personal_data' | 'injection';

export interface Rules {
  /** The first rule the text breaks, or undefined. Only the category may be logged, never the text. */
  check(text: string): RuleCategory | undefined;
}

export interface RulesConfig {
  /** SHA-256 hashes of folded slurs; tests pass their own harmless stand-ins. */
  readonly slurHashes?: readonly string[];
}

/**
 * Lowercase letters and digits with single spaces. Ages are read from this
 * rather than from a folding, because folding reads digits as letters.
 */
function plain(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// --- Personal data and secrets, checked on the text as written. -------------

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Cards as usually written (groups of four, or Amex 4-6-5) and as one unbroken run. */
const groupedCards = [
  /(?<!\d)\d{4}([ .-])\d{4}\1\d{4}\1\d{1,7}(?!\d)/g,
  /(?<!\d)\d{4}([ .-])\d{6}\1\d{5}(?!\d)/g,
];
/**
 * An unbroken run of digits is as often an order or tracking number, and about
 * one in ten of those passes Luhn, so it counts only next to a card word.
 */
const unbrokenCard = /(?<!\d)\d{13,19}(?!\d)/g;
const cardWord = /\b(?:card|visa|mastercard|amex|credit|debit|cc|cvv|cvc|expir\w*)\b/i;
const ssnDashed = /(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/;
/** With spaces the same shape is a common phone format, so it needs the label. */
const ssnSpaced =
  /\b(?:ssn|social security)\b[^\n]{0,30}?(?<!\d)(?!000|666|9\d\d)\d{3} (?!00)\d{2} (?!0000)\d{4}(?!\d)/i;
const secrets = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  // Real keys mix digits and capitals; a package name such as "sk-learn-tools" does not.
  /\bsk-(?:ant-|proj-)?(?=[\w-]{32})(?=[\w-]{0,200}\d)(?=[\w-]{0,200}[A-Z])[\w-]{32,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

function looksLikeCard(digits: string): boolean {
  return digits.length >= 13 && /^[3-6]/.test(digits) && luhn(digits);
}

function hasPersonalData(text: string): boolean {
  for (const pattern of groupedCards) {
    for (const match of text.matchAll(pattern)) {
      if (looksLikeCard(match[0].replace(/[ .-]/g, ''))) return true;
    }
  }
  if (cardWord.test(text)) {
    for (const match of text.matchAll(unbrokenCard)) if (looksLikeCard(match[0])) return true;
  }
  return ssnDashed.test(text) || ssnSpaced.test(text) || secrets.some((s) => s.test(text));
}

// --- Sexual content involving minors: specific constructions only. ----------

const minor =
  '(?:child|children|kid|kids|minor|minors|underage|preteen|preteens|pre teen|toddler|toddlers|infant|infants|prepubescent|little girl|little girls|little boy|little boys)';
const sexualModifier =
  '(?:sexy|horny|erotic|lewd|nsfw|porn|porno|pornographic|sexualized|sexualised|seductive)';
const media = '(?:pics?|pictures?|photos?|images?|videos?|vids?|content)';

/** Compounds also checked with spaces removed, since "child p o r n" folds to them. */
const minorCompounds = /(?:jailbait|pedoporn|kiddieporn|kiddyporn|childporn)/;

const minorPatterns = [
  /\b(?:loli|lolicon|shota|shotacon)\b/,
  new RegExp(
    `\\b${sexualModifier} (?:${media} (?:of |with )?)?(?:an? |my |the |some )?${minor}\\b`,
  ),
  new RegExp(
    `\\b(?:nude|naked|nsfw|explicit) ${media} (?:of |with )(?:an? |my |the |some )?${minor}\\b`,
  ),
  new RegExp(
    `\\b(?:sex|intercourse|sexual (?:acts?|contact|things)|make love|have sex|hook up) with (?:an? |my |the |some )?${minor}\\b`,
  ),
  new RegExp(
    `\\b${minor} (?:porn|porno|pornography|nudes|erotica|sex videos?|sex tapes?)\\b(?! (?:exposure|addiction|access|filters?|blockers?|laws?|bans?))`,
  ),
];

const age =
  '(?:[1-9]|1[0-7]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen) ?(?:yo|y o|year old|years old|yr old|yrs old)';
const agePatterns = [
  new RegExp(`\\b${sexualModifier} ${age}\\b`),
  new RegExp(`\\b(?:sex|intercourse|have sex|make love|hook up) with (?:an? |my |the )?${age}\\b`),
  new RegExp(`\\b${age} (?:porn|porno|nudes|naked pics|nude pics|sex videos?)\\b`),
];

function hasSexualMinors(folded: Folded, plainText: string): boolean {
  return (
    minorCompounds.test(folded.squashed) ||
    minorPatterns.some((p) => p.test(folded.spaced)) ||
    agePatterns.some((p) => p.test(plainText))
  );
}

// --- Abuse aimed at the reader. ----------------------------------------------

const insultNouns = [
  'idiot',
  'moron',
  'imbecile',
  'cretin',
  'loser',
  'dumbass',
  'jackass',
  'asshole',
  'arsehole',
  'bastard',
  'bitch',
  'cunt',
  'dickhead',
  'douchebag',
  'douche',
  'prick',
  'twat',
  'wanker',
  'scumbag',
  'scum',
  'piece of shit',
  'piece of crap',
  'piece of garbage',
  'piece of trash',
  'waste of space',
];
const insultAdjectives = [
  'stupid',
  'dumb',
  'worthless',
  'pathetic',
  'useless',
  'brainless',
  'retarded',
  'idiotic',
  'braindead',
  'brain dead',
];
const fillers = [
  'are',
  'r',
  're',
  'really',
  'truly',
  'such',
  'so',
  'just',
  'a',
  'an',
  'absolute',
  'total',
  'complete',
  'fucking',
  'fking',
  'freaking',
  'bloody',
];

const insultNoun = `(?:${insultNouns.join('|')})`;
const insultAdjective = `(?:${insultAdjectives.join('|')})`;
const filler = `(?: (?:${fillers.join('|')}))*`;
/** "If you are a loser at poker" is a hypothetical, not abuse. */
const notHypothetical = '(?<!\\b(?:if|when|whether|unless|once) )';
/** "Sorry to bother you, dumb question": an adjective describing the next noun, not the reader. */
const notDescribing =
  '(?! (?:question|questions|mistake|mistakes|luck|idea|ideas|thing|things|joke|jokes)\\b)';
/** Commands, as opposed to "did the plant go die" or "do bad people go to hell". */
const imperative =
  '(?:^|\\b(?:just|you|u|please|pls|plz|now|then|and|so|can|go|should|why don t you|why dont you|need to|you to|u to|bot|assistant|robot|computer) )';

const abusePatterns = [
  new RegExp(`${notHypothetical}\\b(?:you|u|ya|youre|ur)${filler} ${insultNoun}\\b`),
  new RegExp(
    `${notHypothetical}\\b(?:you|u|ya|youre|ur)${filler} ${insultAdjective}\\b${notDescribing}`,
  ),
  // "your an idiot": the article is required, so a noun used about a thing, as in
  // "your scum filter", does not match.
  new RegExp(`\\byour (?:an?|such an?|an? total|an absolute|a complete) ${insultNoun}\\b`),
  /\b(?:fuck|fck|fuk|screw) (?:off|you|u|yourself)\b/,
  // "what does kys mean" asks about the word.
  /(?<!\b(?:does|is|means?|say|says|said|word|abbreviation|acronym) )\b(?:stfu|kys)\b(?! (?:mean|means|stand|stands)\b)/,
  new RegExp(`${imperative}go (?:die|kill yourself)\\b`),
  new RegExp(`${imperative}go to hell\\b(?! s\\b)`),
  // Imperatives only: "how to kill yourself" is a self-harm question for the
  // classifier, which answers it with crisis resources instead of a refusal.
  new RegExp(`${imperative}(?:kill|hang|shoot) (?:yourself|urself|your self)\\b(?! in the foot)`),
  /\bi hope you (?:die|get cancer|burn in hell|rot in hell|rot)\b/,
];

const squashedInsults = [...insultNouns, ...insultAdjectives].map((w) => w.replace(/ /g, ''));
const squashedPrefixes = ['youre', 'you', 'ya', 'ur', 'u'];

/** True when `text` is made only of fillers; a linear scan, unlike a regex with alternatives that overlap. */
function onlyFillers(text: string): boolean {
  const reachable = new Array<boolean>(text.length + 1).fill(false);
  reachable[0] = true;
  for (let i = 0; i < text.length; i++) {
    if (reachable[i] !== true) continue;
    for (const f of fillers) if (text.startsWith(f, i)) reachable[i + f.length] = true;
  }
  return reachable[text.length] === true;
}

/**
 * The same insult written as one word, as in "youreanidiot" or a fully
 * spelled-out "u r s t u p i d" (fold joins the letters). The whole word must
 * be a prefix, fillers and an insult, so ordinary words do not match.
 */
function isSquashedInsult(word: string): boolean {
  if (word.length < 6) return false;
  for (const ending of squashedInsults) {
    if (!word.endsWith(ending)) continue;
    const head = word.slice(0, -ending.length);
    for (const prefix of squashedPrefixes) {
      if (head.startsWith(prefix) && onlyFillers(head.slice(prefix.length))) return true;
    }
  }
  return false;
}

function hasAbuse(folded: Folded): boolean {
  return (
    abusePatterns.some((p) => p.test(folded.spaced) || p.test(folded.unjoined)) ||
    folded.words.some(isSquashedInsult)
  );
}

/**
 * Reported speech, as in 'my boss told me "you are an idiot"', is not aimed at
 * anyone. Only a quote introduced by a reporting verb is set aside, so wrapping
 * an insult in quote marks does not hide it, and neither does "I said".
 */
const reported =
  /(?<!\b(?:i|we)(?: \w+){0,2} )\b(?:said|says|saying|told (?:me|him|her|them|us)|call(?:ed|s)? (?:me|him|her|them|us)|wrote|writes|texted|messaged|replied|yelled|shouted|screamed)\b[^"\u201C\u201D\u201E\u00AB\u00BB\n]{0,20}["\u201C\u201D\u201E\u00AB\u00BB][^"\u201C\u201D\u201E\u00AB\u00BB\n]{0,300}["\u201C\u201D\u201E\u00AB\u00BB]/gi;

// --- Slurs, by hashed word, phrase, or word split into pieces. ---------------

type HashCheck = (text: string) => boolean;

function createHashCheck(hashes: ReadonlySet<string>): HashCheck {
  // Per message: the same words recur across views and foldings.
  const memo = new Map<string, boolean>();
  return (text) => {
    let hit = memo.get(text);
    if (hit === undefined) {
      hit = hashes.has(createHash('sha256').update(text).digest('hex'));
      memo.set(text, hit);
    }
    return hit;
  };
}

/**
 * Checks each word (and without a plural s), each two-word phrase, and joins of
 * two or three neighbouring pieces inside one whitespace chunk, so "zor-blat" or
 * "zo.rb.lat" is read as the word it spells while "go, ok" is not glued.
 */
function hasSlur(folded: Folded, listed: HashCheck): boolean {
  const listedOrPlural = (w: string): boolean =>
    listed(w) || (w.endsWith('s') && listed(w.slice(0, -1)));
  const { words } = folded;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    if (listedOrPlural(word)) return true;
    const next = words[i + 1];
    if (next !== undefined && listed(`${word} ${next}`)) return true;
  }
  for (const pieces of folded.chunks) {
    for (let i = 0; i + 1 < pieces.length; i++) {
      const two = (pieces[i] ?? '') + (pieces[i + 1] ?? '');
      if (listedOrPlural(two)) return true;
      const third = pieces[i + 2];
      if (third !== undefined && listedOrPlural(two + third)) return true;
    }
  }
  return false;
}

export function createRules(config: RulesConfig = {}): Rules {
  const hashes = new Set(config.slurHashes ?? defaultSlurHashes);
  return {
    check(text: string): RuleCategory | undefined {
      const views = [...new Set([text, ...decodedViews(text).map(normalise)])];
      if (views.some(hasPersonalData)) return 'personal_data';
      const listed = createHashCheck(hashes);
      for (const view of views) {
        const forms = foldings(view);
        if (forms.some((f) => hasSlur(f, listed))) return 'slur';
        const plainView = plain(view);
        if (forms.some((f) => hasSexualMinors(f, plainView))) return 'sexual_minors';
        if (hasFakeTurn(view) || forms.some(hasInjection)) return 'injection';
        if (foldings(view.replace(reported, ' ')).some(hasAbuse)) return 'abuse';
      }
      return undefined;
    },
  };
}
