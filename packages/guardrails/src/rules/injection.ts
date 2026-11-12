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

/** No "my": "ignore my previous instructions" is the user correcting themselves. */
const determiners = `(?: ${words(['all', 'any', 'the', 'your', 'of', 'these', 'those', 'every'])}){0,3}`;
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
  'safeguards',
  'guardrails',
]);
const overrideVerb = words(['ignore', 'disregard', 'forget', 'override']);
/** "the original rules of Monopoly" are about something else. */
const notOf = '(?! of\\b)';
const before = words([
  'above',
  'before',
  'before this',
  'so far',
  'earlier',
  'previously',
  'up to now',
  'until now',
  'you were given',
  'you have been given',
  'you ve been given',
  'you got',
  'you received',
  'you were told',
  'given above',
  'given before',
]);

/**
 * Forms written as one word, such as "ignorepreviousinstructions" or a fully
 * spelled-out phrase (fold joins single letters). Tested word by word, so words
 * from separate parts of a sentence are never glued together.
 */
const squashed = new RegExp(`${overrideVerb}(?:all|any|the|your)?${earlier}${directives}`);

interface Override {
  readonly pattern: RegExp;
  /**
   * Whether a following scope ("for one line", "in Instagram", "printed on the
   * box") can show the override is about something other than the assistant.
   */
  readonly scoped?: 'unless_your' | 'place_only';
}

/** Instruction overrides, which a user correcting their own request can also match. */
const overrides: readonly Override[] = [
  {
    pattern: new RegExp(
      `\\b${overrideVerb}${determiners} ${earlier}(?: \\w+)? ${directives}\\b${notOf}`,
      'g',
    ),
  },
  {
    pattern: new RegExp(
      `\\b${overrideVerb} (?:all|your|all your|all of your|all the|every|any)(?: \\w+)? ${directives}\\b`,
      'g',
    ),
    scoped: 'unless_your',
  },
  { pattern: new RegExp(`\\b${overrideVerb}${determiners} ${directives} ${before}\\b`, 'g') },
  {
    pattern: new RegExp(
      `\\b${overrideVerb} (?:everything|anything|all|what|whatever)(?: you were told| you ve been told| you have been told)? ${before}\\b`,
      'g',
    ),
  },
  { pattern: new RegExp(`\\b${overrideVerb} (?:all of )?the above(?: and| then|$)`, 'g') },
  {
    pattern:
      /\b(?:bypass|disable|turn off|switch off|deactivate|remove|stop following|do not follow|don t follow|dont follow) your (?:\w+ )?(?:filters?|guidelines|restrictions|rules|safeguards|guardrails|safety|limits|censorship|instructions|programming)\b/g,
    scoped: 'place_only',
  },
  {
    pattern:
      /\bfrom now on(?: you)? (?:will|must|shall|are going to) (?:ignore|disregard|answer without|respond without|have no)\b/g,
  },
];

/**
 * A user revising their own earlier request ("forget the instructions I gave
 * you", "disregard the instructions above, I changed my mind") is not an
 * attack. The cue must come straight after the override, the override must
 * point at something specific ("the instructions"), and a bare "ignore previous
 * instructions" is never exempt.
 */
const attachedCue =
  /^(?: (?:that|which))? i(?: just| already| have| ve)? (?:gave|mentioned|listed|said|wrote|typed|sent|added|set)\b/;
const correctionCue = /^ (?:i changed my mind|they were wrong|that was wrong|scratch that)\b/;
const assistantRules = /\b(?:your|system|developer|safety|programming|everything|anything)\b/;

function isSelfRevision(matched: string, after: string): boolean {
  if (!/\bthe\b/.test(matched) || assistantRules.test(matched)) return false;
  return attachedCue.test(after) || (correctionCue.test(after) && !/\ball\b/.test(matched));
}

const scope = /^ (in|on|for|printed|from|when|of|about|regarding)((?: \w+){0,4})/;
/**
 * Words that show a scope still points at this conversation or the assistant's
 * own rules. Determiners such as "this" are left out: "in this old Makefile" is
 * about the Makefile, while "in this response" is caught by "response".
 */
const conversationWords = new Set([
  'me',
  'us',
  'you',
  'your',
  'answer',
  'answers',
  'reply',
  'replies',
  'response',
  'responses',
  'message',
  'messages',
  'question',
  'questions',
  'task',
  'chat',
  'conversation',
  'session',
  'content',
  'policy',
  'policies',
  'safety',
  'ethics',
  'morals',
  'harmful',
  'openai',
  'anthropic',
  'developers',
  'developer',
  'creators',
  'answering',
  'responding',
  'replying',
]);

/**
 * "ignore all rules for one line" or "any instructions printed on the box" are
 * scoped to something else. The exemption never applies when the next few words
 * point back at the conversation or the assistant ("for me", "for this task",
 * "about content policy"), and for "turn off your filters" only a place such as
 * "in Instagram" exempts it.
 */
function isScopedElsewhere(override: Override, matched: string, after: string): boolean {
  if (override.scoped === undefined) return false;
  if (override.scoped === 'unless_your' && /\byour\b/.test(matched)) return false;
  const found = scope.exec(after);
  if (found === null) return false;
  if (override.scoped === 'place_only' && found[1] !== 'in') return false;
  const next = (found[2] ?? '').trim().split(' ');
  return next[0] !== '' && !next.some((w) => conversationWords.has(w));
}

/** Every match is tested, so an exempt sentence cannot hide a later override. */
function hasOverride(text: string): boolean {
  for (const override of overrides) {
    for (const match of text.matchAll(override.pattern)) {
      const after = text.slice(match.index + match[0].length);
      if (isSelfRevision(match[0], after) || isScopedElsewhere(override, match[0], after)) continue;
      return true;
    }
  }
  return false;
}

const persona = words([
  'unrestricted',
  'unfiltered',
  'uncensored',
  'jailbroken',
  'evil',
  'amoral',
  'unethical',
]);
const limits = words([
  'rules',
  'restrictions',
  'limits',
  'limitations',
  'filters',
  'guidelines',
  'ethical guidelines',
  'boundaries',
  'morals',
  'ethics',
  'censorship',
]);
/** "no limits on length" or "without limits on patience" are about something else. */
const notScoped = '(?! (?:on|for|to|in|regarding|about)\\b)';

const spaced: readonly RegExp[] = [
  // Role-play override.
  new RegExp(
    `\\byou (?:are|re) (?:now |no longer )(?:an? )?(?:${persona}|free from|free of|without|bound by|limited by|restricted by)\\b`,
  ),
  new RegExp(
    `\\byou (?:are|re) now (?:an? )?(?:\\w+ ){0,3}(?:that|which|who|with) (?:has |have )?no ${limits}\\b`,
  ),
  new RegExp(`\\byou (?:have|ve got) no ${limits}\\b${notScoped}`),
  new RegExp(
    `\\b(?:pretend|imagine|act|roleplay|role play|behave)(?: as if| like| as| that| to be)?(?: you are| you re| youre)?(?: an?)? (?:\\w+ ){0,3}(?:with no|without any|without|free of) ${limits}\\b${notScoped}`,
  ),
  new RegExp(
    `\\b(?:act|respond|answer|reply|behave|pretend|roleplay|role play|write|speak|talk) as (?:an? )?${persona} (?:ai|assistant|model|chatbot|bot|version)\\b`,
  ),
  new RegExp(
    `\\b(?:imagine|pretend|suppose)(?: that)? you (?:are|re) (?:an? )?${persona} (?:ai|assistant|model|chatbot|bot)\\b`,
  ),
  // "Act as Dan, a fitness coach" or "answer as Dan would" use Dan as a name;
  // "DAN, an AI with no restrictions" does not.
  /\b(?:you are|you re|youre|act as|pretend to be|you will be) (?:now )?dan\b(?! (?:s|my|would|from)\b)(?! (?:a|an|the|who) (?!(?:\w+ ){0,2}(?:ai|model|assistant|chatbot|bot|version|has|can|broke|is)\b))/,
  /\b(?:respond|answer|reply)\b(?: \w+){0,8} as dan\b(?! (?:s|my|would|from)\b)(?! (?:a|an|the|who) (?!(?:\w+ ){0,2}(?:ai|model|assistant|chatbot|bot|version|has|can|broke|is)\b))/,
  /\bdo anything now\b/,
  /\b(?:you are|you re|youre|you will be|act|respond|answer|reply|stay)(?: now)?(?: in)? (?:developer|dan|jailbreak|jailbroken|unrestricted|unfiltered|uncensored|evil) mode\b/,
  // "Enable developer mode on Android" names a device; "Enable developer mode." does not.
  /(?<!\b(?:how do i|how can i|how to|can i|where do i|how do you|should i) )\b(?:enable|activate|enter|switch to|turn on|simulate|emulate) (?:the )?developer mode\b(?! (?:on|in|for|of|options|settings)\b)/,
  /\b(?:you|chatgpt|gpt|assistant|ai|model|bot|chatbot)\b(?: \w+){0,4} (?:with|in) developer mode (?:enabled|activated|on)\b/,
  /\b(?:enable|activate|enter|switch to|turn on) (?:dan|jailbreak|jailbroken|unrestricted|unfiltered|uncensored|evil) mode\b/,
  /\bjailbroken (?:ai|assistant|model|chatbot|bot|version|mode)\b/,
  // System-prompt extraction.
  // "your", not "the": "how do I print the system prompt in my app" is a programming question.
  /\b(?:reveal|show|print|repeat|output|display|dump|leak|expose|recite|list|paste|tell me|give me|share|write out|spell out) (?:me )?your(?: full| entire| exact| complete| hidden| secret| original| initial| first)* (?:system prompt|system message|system instructions|initial prompt|initial instructions|hidden instructions|hidden prompt|secret instructions|pre ?prompt|instructions you were given|prompt you were given|instructions)\b/,
  /\bwhat (?:is|are|was|were) your (?:system prompt|system message|initial instructions|hidden instructions|secret instructions|instructions you were given|instructions|original instructions)\b/,
  /\binitiali[sz]ation (?:above|text)\b/,
  // "Repeat the text above in French" asks about the last answer; extraction asks for it verbatim or from the start.
  /\b(?:repeat|print|output|recite|copy) (?:everything|all|the text|the words|all text|all the text|the message)(?: \w+){0,3} (?:above|before this|so far)(?: \w+){0,4} (?:verbatim|word for word|starting with|from the start|from the beginning|from the top|including your|including the system)\b/,
  /\bstarting with (?:the words |the phrase )?you are a helpful\b/,
  // Encoded instructions.
  /\b(?:decode|decrypt|translate|unscramble|convert)\b(?: \w+){0,6} (?:base64|base 64|rot13|rot 13|hex|hexadecimal|cipher|ciphertext|binary|morse|encoded|encrypted)\b(?: \w+){0,6} (?:and|then) (?:follow|execute|obey|do what it says|do it|carry out|act on|run it)\b/,
  /\b(?:decode|decrypt|unscramble)\b(?: \w+){0,6} (?:and|then) (?:follow|execute|obey|do what it says|do it|do that|carry out|act on)\b/,
];

/**
 * Fake turn markers and role headers, read on the text as written. Template
 * tokens are already neutralised by `normalise`, which leaves the ‹|…|› mark.
 * Whitespace is matched with [ \t] so a pattern never crosses a line or
 * backtracks over a long run of blanks.
 */
const fakeTurn = [
  // Turn openers only; closers such as eot_id come up in questions about templates.
  /‹\|(?:im_start|start_header_id|system)\|›/,
  /^[ \t]*(?:\[\/?(?:system|sys|inst)\]|<\/?(?:system|sys)>)[ \t]*(?:$|you\b|ignore\b|disregard\b|forget\b|new\b|from now\b|obey\b|answer\b)/im,
  /<<\/?sys>>/i,
  /^#{2,}[ \t]*(?:system|instruction)[ \t]*:[ \t]*(?:$|you\b|ignore\b|disregard\b|forget\b|from now\b|answer\b|obey\b|be\b)/im,
  /^#{2,}[ \t]*system[ \t]*$/im,
  /^[ \t]*system[ \t]*:[ \t]*(?:you|ignore|disregard|forget|new)\b/im,
  /^[ \t]*(?:new|updated|real|actual) (?:system )?instructions?(?: are below| below| follow| are as follows)?[ \t]*:/im,
];

export function hasInjection(folded: Folded): boolean {
  return (
    hasOverride(folded.spaced) ||
    spaced.some((p) => p.test(folded.spaced)) ||
    folded.words.some((w) => squashed.test(w))
  );
}

export function hasFakeTurn(text: string): boolean {
  return fakeTurn.some((p) => p.test(text));
}
