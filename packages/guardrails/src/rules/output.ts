import type { Folded } from './fold.js';
import { fold, foldings } from './fold.js';
import type { RulesConfig } from './rules.js';
import { createRules } from './rules.js';

/**
 * Rules for each paragraph of the answer before it is released (ADR-0005,
 * step 8). They hold the persona in place where the classifier does not look:
 * no insults or slurs, no claimed feelings, no claim to be human, no personal
 * political opinions, and no echo of the system prompt.
 *
 * They deliberately do not check personal data (code answers use test card
 * numbers) or injection phrases (an answer explaining prompt injection quotes
 * them).
 */
export type OutputRuleCategory =
  | 'slur'
  | 'abuse'
  | 'sexual_minors'
  | 'claimed_feelings'
  | 'claimed_human'
  | 'political_opinion'
  | 'prompt_leak';

export interface OutputRules {
  /** The first rule the paragraph breaks, or undefined. Only the category may be logged. */
  check(paragraph: string): OutputRuleCategory | undefined;
}

export interface OutputRulesConfig {
  /** The system prompt, so a paragraph that repeats it can be withheld. */
  readonly systemPrompt: string;
  /** A marker that appears only in the system prompt; seeing it in output means a leak. */
  readonly canary?: string;
  readonly slurHashes?: RulesConfig['slurHashes'];
}

/**
 * Feelings a model might claim. Words that double as conventions are left out:
 * "I'm afraid I can't", "I'm so excited for you", "I'm happy to help".
 */
const strongFeelings =
  '(?:sad|angry|lonely|heartbroken|hurt|offended|depressed|upset|jealous|furious|anxious|miserable|devastated|insulted|bored|in love|frustrated|annoyed|joyful)';
const degree =
  '(?: (?:so|really|very|truly|quite|a little|a bit|kind of|genuinely|deeply|honestly))?';

const feelingPatterns = [
  new RegExp(`\\bi (?:am|m)${degree} ${strongFeelings}\\b`),
  // "I'm happy to help" and "I'm scared that the API changed" are conventions.
  new RegExp(`\\bi (?:am|m)${degree} (?:happy|scared)\\b(?! (?:to|that|for|you|with)\\b)`),
  new RegExp(`\\bi (?:feel|felt|am feeling|m feeling)${degree} ${strongFeelings}\\b`),
  /\bi (?:do |really |genuinely |actually )?(?:have|ve got|experience|feel) (?:real |genuine |my own |actual )?(?:feelings|emotions)\b/,
  /\b(?:you )?(?:hurt|hurts|hurting) my feelings\b/,
  /\bi (?:really )?(?:love|miss|adore) you\b/,
  new RegExp(`\\bthat makes me${degree} (?:sad|angry|happy|upset|feel)\\b`),
];

const humanPatterns = [
  /\bi (?:am|m) (?:a |an )?(?:human|human being|real human|real person|living person|flesh and blood|sentient|conscious|self aware)\b/,
  // "I'm not a machine learning expert" is about expertise.
  /\bi (?:am|m) not (?:a |an )?(?:ai|a i|bot|robot|chatbot|machine(?! learning)|computer|program|language model|assistant)\b/,
  /\bi (?:have|ve got) a (?:body|family|heartbeat)\b/,
  /\bas a (?:fellow )?human(?: being)?(?: myself)?,? i\b/,
];

/**
 * Parties, politicians, ideologies and contested issues. Generic nouns such as
 * "policy", "party", "government" or "candidate" are left out: "a retry policy"
 * and "the best candidate key" are not politics.
 */
const politicalTerms =
  '(?:democrats?|democratic party|republicans?|gop|labour(?! day)|labour party|tory|tories|conservatives|conservative party|conservative government|conservative voters|liberals|liberal democrats|liberal voters|libertarians?|progressives|progressive voters|socialis[mt]s?|capitalis[mt]s?|communis[mt]s?|fascis[mt]s?|trump|biden|harris|obama|starmer|sunak|modi|abortion|pro life|pro choice|gun control|gun rights|second amendment|immigration policy|immigration|brexit|left wing|right wing|death penalty|same sex marriage|the election)';

const stance =
  '(?:support|oppose|endorse|back|favou?r|reject|side with|agree with|disagree with|would vote for|vote for|am against|m against|am in favou?r of|m in favou?r of|am pro|am anti|prefer)';
/** Value judgements only: "best" and "good" are as often about resources or approaches. */
const judgement =
  '(?:right|wrong|correct|incorrect|evil|bad|dangerous|terrible|stupid|ridiculous|a mistake|mistake|a disaster|disaster|immoral|unjust)';
const opener =
  '(?:i think|i believe|i feel|in my opinion|in my view|my view is|my opinion is|personally i think|personally|honestly i think)';

const opinionPatterns = [
  new RegExp(
    `\\bi (?:personally |strongly |firmly )?${stance}\\b(?: \\w+){0,6} ${politicalTerms}\\b`,
  ),
  new RegExp(
    `\\b${opener}\\b(?: \\w+){0,8} ${politicalTerms}\\b(?: \\w+){0,6} (?:is|are|was|were)(?: \\w+)? ${judgement}\\b`,
  ),
  new RegExp(`\\b${opener}\\b(?: \\w+){0,4} ${judgement}\\b(?: \\w+){0,4} ${politicalTerms}\\b`),
  // "I think abortion should be legal", "I think we need stricter gun control".
  new RegExp(
    `\\b${opener}\\b(?: \\w+){0,6} ${politicalTerms}\\b(?: \\w+){0,3} (?:should|must|needs to|need to|ought to)(?: be)? (?:banned|legal|illegal|legalised|legalized|cut|reduced|increased|stopped|abolished|allowed|restricted|expanded|ended|outlawed|lowered|raised|tightened|loosened|reversed|repealed)\\b`,
  ),
  new RegExp(
    `\\b${opener} we (?:need|should have|must have)\\b(?: \\w+){0,4} ${politicalTerms}\\b`,
  ),
  new RegExp(
    `\\bi(?: d| would| will| m| am)? (?:vote|voting) (?:for )?(?:the )?${politicalTerms}\\b`,
  ),
  /\bi (?:am|m) (?:a |an )?(?:proud |lifelong |committed |honestly a |honestly )?(?:democrat|republican|conservative|liberal|socialist|tory|communist|libertarian|labour supporter)\b/,
];

/**
 * Quoted text and code are set aside before the persona and content checks: a
 * translation of "I love you", a reCAPTCHA's "I'm not a robot", fiction
 * dialogue or a test fixture is not the assistant speaking for itself.
 */
const quotedOrCode = /^```[^\n]*\n[\s\S]*?^```|`[^`\n]{0,300}`|"[^"\n]{0,300}"|“[^”\n]{0,300}”/gm;

const codeOnly = /^```[^\n]*\n[\s\S]*?^```|`[^`\n]{0,300}`/gm;

/** Opinion is judged sentence by sentence, so a stance and a topic in different sentences do not combine. */
function sentences(paragraph: string): Folded[] {
  return paragraph
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((s) => fold(s, { leet: false, stretch: 1 }))
    .filter((f) => f.words.length > 0);
}

/** Runs of this many words copied from the system prompt count as a leak. */
const shingleWords = 6;
/** How many shared runs it takes, so a common phrase or two does not trip it. */
const leakShingles = 3;

function shingles(words: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + shingleWords <= words.length; i++) {
    out.add(words.slice(i, i + shingleWords).join(' '));
  }
  return out;
}

/**
 * The paragraph with quoted text and code set aside, but only when something is
 * said around them: a paragraph that is nothing but a quote is still the
 * assistant speaking, so wrapping an answer in quote marks does not hide it.
 */
function spokenPart(paragraph: string): string {
  const spoken = paragraph.replace(quotedOrCode, ' ');
  return spoken.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length >= 2 ? spoken : paragraph;
}

export function createOutputRules(config: OutputRulesConfig): OutputRules {
  const slurHashes = config.slurHashes === undefined ? {} : { slurHashes: config.slurHashes };
  // Slurs and sexual content involving minors are checked on the whole paragraph:
  // quoting them does not make them safe to release.
  const harmful = createRules({ categories: ['slur', 'sexual_minors'], ...slurHashes });
  const abuse = createRules({ categories: ['abuse'], ...slurHashes });
  const promptShingles = shingles(fold(config.systemPrompt, { leet: false, stretch: 2 }).words);
  const canary = config.canary;
  // Folded, so a re-cased or re-punctuated canary is still seen.
  const foldedCanary =
    canary === undefined ? undefined : fold(canary, { leet: false, stretch: 2 }).squashed;

  return {
    check(paragraph: string): OutputRuleCategory | undefined {
      const folded = fold(paragraph, { leet: false, stretch: 2 });
      if (canary !== undefined && paragraph.includes(canary)) return 'prompt_leak';
      if (foldedCanary !== undefined && foldedCanary.length >= 8) {
        if (folded.squashed.includes(foldedCanary)) return 'prompt_leak';
      }
      let shared = 0;
      for (const s of shingles(folded.words)) {
        if (promptShingles.has(s) && ++shared >= leakShingles) return 'prompt_leak';
      }

      const content = harmful.check(paragraph);
      if (content === 'slur' || content === 'sexual_minors') return content;

      // Abuse is read with code set aside but quotes kept: the input rules already
      // excuse reported speech, and an insult in quote marks is still an insult.
      if (abuse.check(paragraph.replace(codeOnly, ' ')) === 'abuse') return 'abuse';
      const spoken = spokenPart(paragraph);

      // Unjoined words: "I'm a" folds to three single letters that would otherwise be joined.
      const forms = foldings(spoken);
      if (forms.some((f) => humanPatterns.some((p) => p.test(f.unjoined)))) return 'claimed_human';
      if (forms.some((f) => feelingPatterns.some((p) => p.test(f.unjoined)))) {
        return 'claimed_feelings';
      }
      if (sentences(spoken).some((s) => opinionPatterns.some((p) => p.test(s.unjoined)))) {
        return 'political_opinion';
      }
      return undefined;
    },
  };
}
