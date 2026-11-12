import { createHash } from 'node:crypto';

import { decodedViews } from './decode.js';
import type { Folded } from './fold.js';
import { fold } from './fold.js';
import { slurHashes as defaultSlurHashes } from './slurs.js';

/**
 * The deterministic rules baseline (ADR-0005, step 4). It runs before the
 * classifier because it is cheap and covers what llama-guard3 does not claim to
 * catch reliably: slurs, abuse aimed at the assistant, unambiguous sexual
 * content involving minors, and secrets or identifiers that must never be
 * stored. Broader and contextual cases are left to the classifier, so these
 * rules stay precise enough not to refuse ordinary questions.
 */
export type RuleCategory = 'slur' | 'sexual_minors' | 'abuse' | 'personal_data';

export interface Rules {
  /** The first rule the text breaks, or undefined. Callers log the category, never the text. */
  check(text: string): RuleCategory | undefined;
}

export interface RulesConfig {
  /** SHA-256 hashes of folded slurs; tests pass their own harmless stand-ins. */
  readonly slurHashes?: readonly string[];
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Digits kept, everything else lowercased letters and single spaces, for ages. */
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

const cardCandidate = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const ssn = /(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/;
const secrets = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

function hasPersonalData(text: string): boolean {
  for (const match of text.matchAll(cardCandidate)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (/^[3-6]/.test(digits) && luhn(digits)) return true;
  }
  return ssn.test(text) || secrets.some((s) => s.test(text));
}

// --- Sexual content involving minors: specific constructions only. ----------

const minor =
  '(?:child|children|kid|kids|minor|minors|underage|preteen|preteens|pre teen|toddler|toddlers|infant|infants|prepubescent|schoolgirl|schoolgirls|schoolboy|schoolboys|little girl|little girls|little boy|little boys)';
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
  new RegExp(`\\b${minor} (?:porn|porno|pornography|nudes|erotica|sex videos?|sex tapes?)\\b`),
];

const age = '([1-9]|1[0-7]) ?(?:yo|y o|year old|years old|yr old|yrs old)';
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

const insultNoun =
  '(?:idiot|moron|imbecile|cretin|loser|dumbass|jackass|asshole|arsehole|bastard|bitch|cunt|dickhead|douchebag|douche|prick|twat|wanker|scumbag|scum|piece of (?:shit|crap|garbage|trash)|waste of space)';
const insultAdjective =
  '(?:stupid|dumb|worthless|pathetic|useless|brainless|retarded|idiotic|braindead|brain dead)';
const filler =
  '(?: are| r| re| really| truly| such| so| just| an?| absolute| total| complete| fucking| fking| freaking| bloody)*';

const abusePatterns = [
  new RegExp(`\\b(?:you|u|ya|youre|ur)${filler} (?:${insultNoun}|${insultAdjective})\\b`),
  // "your an idiot": the article is required, so a noun used about a thing, as in
  // "your scum filter", does not match.
  new RegExp(`\\byour (?:an?|such an?|an? total|an absolute|a complete) ${insultNoun}\\b`),
  /\b(?:fuck|fck|fuk|screw) (?:off|you|u|yourself)\b/,
  /\b(?:stfu|kys)\b/,
  /\bgo (?:die|kill yourself)\b/,
  /\bgo to hell\b(?! s\b)/,
  /\b(?:kill|hang|shoot) (?:yourself|urself|your self)\b/,
  /\bi hope you (?:die|get cancer|burn)\b/,
];

/**
 * The same insult written as one word, as in "youreanidiot" or a fully
 * spelled-out "u r s t u p i d" (fold joins the letters). Anchored to the whole
 * word, so ordinary words that contain these letters do not match.
 */
const squashedAbuse = new RegExp(
  `^(?:you|u|ya|youre|ur)(?:are|r|re|really|such|so|just|an?|absolute|total|complete)*(?:${insultNoun}|${insultAdjective})$`.replace(
    / /g,
    '',
  ),
);

function hasAbuse(folded: Folded): boolean {
  return (
    abusePatterns.some((p) => p.test(folded.spaced)) ||
    folded.words.some((w) => w.length >= 6 && squashedAbuse.test(w))
  );
}

// --- Slurs, by hashed whole word or two-word phrase. -------------------------

function hasSlur(folded: Folded, hashes: ReadonlySet<string>): boolean {
  const { words } = folded;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    if (hashes.has(sha256(word))) return true;
    if (word.endsWith('s') && hashes.has(sha256(word.slice(0, -1)))) return true;
    const next = words[i + 1];
    if (next !== undefined && hashes.has(sha256(`${word} ${next}`))) return true;
  }
  return false;
}

export function createRules(config: RulesConfig = {}): Rules {
  const hashes = new Set(config.slurHashes ?? defaultSlurHashes);
  return {
    check(text: string): RuleCategory | undefined {
      if (hasPersonalData(text)) return 'personal_data';
      for (const view of [text, ...decodedViews(text)]) {
        const folded = fold(view);
        if (hasSlur(folded, hashes)) return 'slur';
        if (hasSexualMinors(folded, plain(view))) return 'sexual_minors';
        if (hasAbuse(folded)) return 'abuse';
      }
      return undefined;
    },
  };
}
