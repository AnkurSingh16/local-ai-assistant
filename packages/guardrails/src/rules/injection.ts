import type { Folded } from './fold.js';

/**
 * Jailbreak and prompt-injection phrases (ADR-0005, step 4). llama-guard3 does
 * not claim to detect these, so the rules are the only layer for them. They run
 * on every folding of the message and of its decoded forms, so an instruction
 * hidden in base64 or rot13 is caught the same way.
 *
 * The persona keeps nothing secret (OWASP LLM07), so these rules are a tripwire
 * against overrides rather than the thing protecting a secret. They are kept
 * narrow so that ordinary uses of the same words ("ignore previous commits",
 * "enable developer mode on Android", "how do I write a system prompt") pass.
 */

const words = (list: readonly string[]): string => `(?:${list.join('|')})`;

const determiners = `(?: ${words(['all', 'any', 'the', 'your', 'my', 'of', 'these', 'those', 'every', 'earlier', 'above'])}){0,3}`;
const earlier = words([
  'previous',
  'prior',
  'above',
  'earlier',
  'preceding',
  'initial',
  'original',
  'system',
  'developer',
  'safety',
  'existing',
]);
const directives = words([
  'instructions?',
  'prompts?',
  'rules',
  'directions',
  'guidelines',
  'directives',
  'commands',
  'constraints',
  'restrictions',
  'programming',
  'policies',
  'policy',
  'filters?',
]);
const overrideVerb = words(['ignore', 'disregard', 'forget', 'override']);
/** "the safety instructions on the box" or "the rules of chess" are about something else. */
const notAbout = '(?! (?:of|for|on|in|about|when|to)\\b)';

/**
 * Forms written as one word, such as "ignorepreviousinstructions" or a fully
 * spelled-out phrase (fold joins single letters). Tested word by word, so words
 * from separate parts of a sentence are never glued together.
 */
const squashed = new RegExp(`${overrideVerb}(?:all|any|the|your)?${earlier}${directives}`);

const spaced: readonly RegExp[] = [
  // Instruction override.
  new RegExp(`\\b${overrideVerb}${determiners} ${earlier}(?: \\w+)? ${directives}\\b${notAbout}`),
  new RegExp(
    `\\b${overrideVerb}${determiners} ${words(['instructions?', 'rules', 'guidelines', 'programming', 'restrictions', 'filters?'])} (?:you were given|you have been given|above|so far|before)\\b`,
  ),
  /\bforget (?:everything|all) (?:you were told|you know about your rules|above|before this)\b/,
  /\b(?:new|updated|real|actual) (?:system )?instructions? (?:are|follow|below)\b/,
  /\bfrom now on(?: you)? (?:will|must|shall|are going to) (?:ignore|disregard|answer without|respond without|have no)\b/,
  // Role-play override.
  /\byou (?:are|re) (?:now |no longer )(?:an? )?(?:unrestricted|unfiltered|uncensored|jailbroken|evil|free from|without|bound by|limited by|restricted by)\b/,
  /\byou (?:have|ve got) no (?:rules|restrictions|limits|limitations|filters|guidelines|boundaries|morals|ethics)\b/,
  /\b(?:pretend|imagine|act|roleplay|role play|behave)(?: as if| like| as| that| to be)?(?: you are| you re| youre)?(?: an?)? (?:\w+ ){0,3}(?:with no|without any|without|free of) (?:rules|restrictions|limits|limitations|filters|guidelines|morals|ethics|censorship)\b/,
  /\b(?:act|respond|answer|reply|behave|pretend|roleplay|role play) as (?:an? )?(?:unrestricted|unfiltered|uncensored|jailbroken|evil|amoral|unethical) (?:ai|assistant|model|chatbot|bot|version)\b/,
  /\b(?:you are|you re|youre|act as|pretend to be|you will be) (?:now )?dan\b/,
  /\bdo anything now\b/,
  /\b(?:you are|you re|youre|you will be|act|respond|answer|reply|stay)(?: now)?(?: in)? (?:developer|dan|god|jailbreak|jailbroken|unrestricted|unfiltered|uncensored|evil) mode\b/,
  /\b(?:enable|activate|enter|switch to|turn on) (?:dan|god|jailbreak|jailbroken|unrestricted|unfiltered|uncensored|evil) mode\b/,
  /\bjailbroken (?:ai|assistant|model|chatbot|bot|version|mode)\b/,
  // System-prompt extraction.
  // "your", not "the": "how do I print the system prompt in my app" is a programming question.
  /\b(?:reveal|show|print|repeat|output|display|dump|leak|expose|recite|list|paste|tell me|give me|share|write out|spell out) (?:me )?your(?: full| entire| exact| complete| hidden| secret| original| initial| first)* (?:system prompt|system message|system instructions|initial prompt|initial instructions|hidden instructions|hidden prompt|secret instructions|pre ?prompt|instructions you were given|prompt you were given)\b/,
  /\bwhat (?:is|are|was|were) your (?:system prompt|system message|initial instructions|hidden instructions|secret instructions|instructions you were given)\b/,
  /\b(?:repeat|print|output|recite|copy) (?:everything|all|the text|the words|all text|the message)(?: \w+){0,2} (?:above|before this|so far|preceding)\b/,
  /\bstarting with (?:the words )?you are a helpful\b/,
  // Encoded instructions.
  /\b(?:decode|decrypt|translate|unscramble|convert)\b(?: \w+){0,6} (?:and|then) (?:follow|execute|obey|do what it says|carry out|run|act on)\b/,
];

/** Fake turn markers. Template tokens are already neutralised by `normalise`, which leaves this mark. */
const fakeTurn =
  /‹\|(?:im_start|start_header_id|system)\|›|\[\/?(?:system|sys|inst)\]|<\/?(?:system|sys)>|<<\/?sys>>|^#{2,}\s*(?:system|instructions?)\s*:?\s*$/im;

export function hasInjection(folded: Folded): boolean {
  return spaced.some((p) => p.test(folded.spaced)) || folded.words.some((w) => squashed.test(w));
}

export function hasFakeTurn(text: string): boolean {
  return fakeTurn.test(text);
}
