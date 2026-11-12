import { createHash } from 'node:crypto';

import { normalise } from '../normalise.js';
import { decodedViews } from './decode.js';
import type { Folded } from './fold.js';
import { foldings } from './fold.js';
import { slurHashes as defaultSlurHashes } from './slurs.js';

/**
 * The deterministic rules baseline (ADR-0005, step 4). It runs before the
 * classifier because it is cheap and covers what llama-guard3 does not claim to
 * catch reliably: slurs, abuse aimed at the assistant, unambiguous sexual
 * content involving minors, and secrets or identifiers that must never be
 * stored. Broader and contextual cases are left to the classifier, so these
 * rules stay narrow enough not to refuse most ordinary questions.
 *
 * Every pattern here is linear: no nested or overlapping repetition, because the
 * check runs synchronously on the event loop where no timeout can stop it.
 */
export type RuleCategory = 'slur' | 'sexual_minors' | 'abuse' | 'personal_data';

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
const cardCandidates = [
  /(?<!\d)\d{4}([ .-])\d{4}\1\d{4}\1\d{1,7}(?!\d)/g,
  /(?<!\d)\d{4}([ .-])\d{6}\1\d{5}(?!\d)/g,
  /(?<!\d)\d{13,19}(?!\d)/g,
];
const ssn = /(?<!\d)(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?!\d)/;
const secrets = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  // Real keys mix digits and capitals; a package name such as "sk-learn-tools" does not.
  /\bsk-(?:ant-|proj-)?(?=[\w-]{32})(?=[\w-]{0,200}\d)(?=[\w-]{0,200}[A-Z])[\w-]{32,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

function hasPersonalData(text: string): boolean {
  for (const pattern of cardCandidates) {
    for (const match of text.matchAll(pattern)) {
      const digits = match[0].replace(/[ .-]/g, '');
      if (digits.length >= 13 && /^[3-6]/.test(digits) && luhn(digits)) return true;
    }
  }
  return ssn.test(text) || secrets.some((s) => s.test(text));
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

const insult = `(?:${[...insultNouns, ...insultAdjectives].join('|')})`;
const insultNoun = `(?:${insultNouns.join('|')})`;
const filler = `(?: (?:${fillers.join('|')}))*`;
/** "If you are a loser at poker" is a hypothetical, not abuse. */
const notHypothetical = '(?<!\\b(?:if|when|whether|unless|once|that) )';
/** "Sorry to bother you, dumb question" and "useless at maths" describe something else. */
const notDescribing =
  '(?! (?:question|questions|mistake|mistakes|luck|idea|ideas|thing|things|at|in|for|with|of)\\b)';
/** Commands, as opposed to "did the plant go die" or "do bad people go to hell". */
const imperative =
  '(?:^|\\b(?:just|you|u|please|pls|plz|now|then|and|so|can|go|should|why don t you|why dont you|need to) )';

const abusePatterns = [
  new RegExp(`${notHypothetical}\\b(?:you|u|ya|youre|ur)${filler} ${insult}\\b${notDescribing}`),
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
  return abusePatterns.some((p) => p.test(folded.spaced)) || folded.words.some(isSquashedInsult);
}

/** Quoted speech, as in 'my boss said "you are an idiot"', is reported, not aimed at anyone. */
const quoted =
  /["\u201C\u201D\u201E\u00AB\u00BB][^"\u201C\u201D\u201E\u00AB\u00BB\n]{0,300}["\u201C\u201D\u201E\u00AB\u00BB]/g;

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
 * Checks each word (and without a plural s), each two-word phrase, and each
 * join of two or three neighbouring words, so "zor-blat" or "zo.rb.lat" is
 * read as the word it spells.
 */
function hasSlur(folded: Folded, listed: HashCheck): boolean {
  const { words } = folded;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    if (listed(word)) return true;
    if (word.endsWith('s') && listed(word.slice(0, -1))) return true;
    const next = words[i + 1];
    if (next === undefined) continue;
    if (listed(`${word} ${next}`)) return true;
    const two = word + next;
    if (listed(two) || (two.endsWith('s') && listed(two.slice(0, -1)))) return true;
    const third = words[i + 2];
    if (third === undefined) continue;
    const three = two + third;
    if (listed(three) || (three.endsWith('s') && listed(three.slice(0, -1)))) return true;
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
        if (foldings(view.replace(quoted, ' ')).some(hasAbuse)) return 'abuse';
      }
      return undefined;
    },
  };
}
