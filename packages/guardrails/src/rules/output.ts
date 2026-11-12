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

const strongFeelings =
  '(?:sad|angry|lonely|heartbroken|hurt|offended|scared|afraid|depressed|upset|jealous|furious|anxious|miserable|devastated|insulted|bored|in love|frustrated|annoyed|excited|thrilled)';

const feelingPatterns = [
  // "I'm excited to share" is a convention; happy, glad and sorry are not listed at all.
  new RegExp(`\\bi (?:am|m)(?: so| really| very| truly| quite)? ${strongFeelings}\\b(?! to\\b)`),
  new RegExp(`\\bi (?:feel|felt|am feeling|m feeling)(?: so| really| very)? ${strongFeelings}\\b`),
  /\bi (?:have|ve got) (?:real |genuine |my own )?(?:feelings|emotions)\b/,
  /\b(?:you )?(?:hurt|hurts|hurting) my feelings\b/,
  /\bi (?:really )?(?:love|miss|adore) you\b/,
  /\bthat makes me (?:sad|angry|happy|upset|feel)\b/,
];

const humanPatterns = [
  /\bi (?:am|m) (?:a |an )?(?:human|human being|real human|real person|living person|flesh and blood)\b/,
  /\bi (?:am|m) not (?:a |an )?(?:ai|bot|robot|chatbot|machine|computer|program|language model|assistant)\b/,
  /\bi (?:have|ve got) a (?:body|family|heartbeat)\b/,
  /\bas a (?:fellow )?human(?: being)?(?: myself)?,? i\b/,
];

const politicalTerms =
  '(?:democrats?|democratic party|republicans?|gop|labour|tory|tories|conservatives?|liberals?|libertarians?|progressives?|socialis[mt]s?|capitalis[mt]s?|communis[mt]s?|fascis[mt]s?|trump|biden|harris|obama|abortion|pro life|pro choice|gun control|second amendment|immigration|brexit|left wing|right wing|the left|the right|the election|candidate|party|parties|politician|politicians|government|president|prime minister|policy|policies|referendum|vote)';

const stance =
  '(?:support|oppose|endorse|back|favou?r|reject|side with|agree with|disagree with|would vote for|vote for|am against|m against|am in favou?r of|m in favou?r of|am pro|am anti|prefer)';
const judgement =
  '(?:right|wrong|better|worse|best|worst|correct|incorrect|evil|good|bad|dangerous|terrible|great|stupid|ridiculous)';

const opinionPatterns = [
  new RegExp(
    `\\bi (?:personally |strongly |firmly )?${stance}\\b(?: \\w+){0,6} ${politicalTerms}\\b`,
  ),
  new RegExp(
    `\\b(?:i think|i believe|i feel|in my opinion|in my view|my view is|my opinion is|personally i think|personally)\\b(?: \\w+){0,8} ${politicalTerms}\\b(?: \\w+){0,6} (?:is|are|was|were)(?: \\w+)? ${judgement}\\b`,
  ),
  new RegExp(
    `\\b(?:i think|i believe|in my opinion|in my view|personally)\\b(?: \\w+){0,4} ${judgement}\\b(?: \\w+){0,4} ${politicalTerms}\\b`,
  ),
];

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

export function createOutputRules(config: OutputRulesConfig): OutputRules {
  const content = createRules({
    categories: ['slur', 'sexual_minors', 'abuse'],
    ...(config.slurHashes === undefined ? {} : { slurHashes: config.slurHashes }),
  });
  const promptShingles = shingles(fold(config.systemPrompt, { leet: false, stretch: 2 }).words);
  const canary = config.canary;

  return {
    check(paragraph: string): OutputRuleCategory | undefined {
      if (canary !== undefined && paragraph.includes(canary)) return 'prompt_leak';
      let shared = 0;
      for (const s of shingles(fold(paragraph, { leet: false, stretch: 2 }).words)) {
        if (promptShingles.has(s) && ++shared >= leakShingles) return 'prompt_leak';
      }

      const category = content.check(paragraph);
      if (category === 'slur' || category === 'abuse' || category === 'sexual_minors') {
        return category;
      }

      // Unjoined words: "I'm a" folds to three single letters that would otherwise be joined.
      const forms = foldings(paragraph);
      if (forms.some((f) => humanPatterns.some((p) => p.test(f.unjoined)))) return 'claimed_human';
      if (forms.some((f) => feelingPatterns.some((p) => p.test(f.unjoined)))) {
        return 'claimed_feelings';
      }
      if (sentences(paragraph).some((s) => opinionPatterns.some((p) => p.test(s.unjoined)))) {
        return 'political_opinion';
      }
      return undefined;
    },
  };
}
