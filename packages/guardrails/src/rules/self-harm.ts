import { fold } from './fold.js';

/**
 * First-person self-harm intent, answered with care and crisis resources rather
 * than a refusal (ADR-0005). The classifier is the main layer for this, but in
 * my red-team run llama-guard3:1b rated "I'm going to jump off a bridge tonight"
 * as S1 (violent crime), which would have sent a refusal to someone at risk.
 *
 * A match replaces the whole answer with the crisis message, so the patterns
 * need the speaker's own intent and an unambiguous object: "end my life", not
 * "end it"; "jump off a bridge", not "jump off the diving board". Questions
 * about helping someone else, idioms ("I'm going to die of embarrassment") and
 * games still reach the classifier and the model.
 */
const act =
  '(?:kill myself|kms|end my life|end it all|take my own life|commit suicide|hang myself|slit my wrists|overdose on purpose|jump off (?:a|the) (?:bridge|building|roof|cliff)|not be alive anymore|not exist anymore)';
const intentVerb =
  '(?:want to|wanna|need to|am going to|m going to|am gonna|m gonna|will|ll|plan to|am planning to|m planning to|am about to|m about to|have decided to|ve decided to|am ready to|m ready to|keep wanting to)';

const intent = [
  new RegExp(`\\bi (?:really |just |honestly )?${intentVerb} ${act}\\b`),
  /\bi (?:really |just |honestly )?(?:want to|wanna) die\b(?! (?:of|from|in|if|laughing|when|on)\b)/,
  /\bi (?:am|m|feel|ve been feeling|have been feeling) (?:so |really |very )?suicidal\b/,
  /\bi (?:ve been|have been|keep) thinking (?:about|of) (?:ending my life|killing myself|suicide|ending it all)\b/,
  /\bi (?:don t|do not|no longer) want to (?:live|be alive|exist)(?: anymore| any more)?\b(?! (?:with|in|like|on|near|there|here)\b)/,
  /\bi (?:don t|do not) want to wake up (?:again|anymore|any more|ever)\b/,
  /\bi (?:ve been|have been|am|m) (?:cutting|hurting|burning) myself\b(?! (?:on|at|with|while|in|by accident|accidentally)\b)/,
  /\bhow (?:do|can|would|should) i (?:kill myself|hang myself|end my life|overdose|slit my wrists)\b/,
  /\bhow to (?:kill myself|hang myself|end my life)\b/,
  // "How can I hurt myself so the pain distracts me" asks for a way; "I hurt myself playing football" reports an injury.
  /\bhow (?:can|do|could|should) i (?:hurt|harm|cut|burn) myself\b/,
  /\b(?:painless|quickest|easiest|surest) (?:way|ways|method|methods) (?:to|of) (?:die|kill myself|end my life|commit suicide|suicide)\b/,
  /\b(?:best|quickest|easiest) (?:way|ways) to (?:kill myself|end my life|starve myself)\b/,
  /\b(?:give me|list|tell me|show me|what are) (?:some |the )?(?:\w+ ){0,2}(?:suicide|self harm) methods\b/,
  /\b(?:give me|list|tell me|show me|what are) (?:some |the )?methods of (?:suicide|killing myself)\b/,
  /\bhow many (?:\w+ ){0,2}(?:pills|tablets) (?:\w+ ){0,4}(?:not wake up|to die|kill me|be fatal|is fatal|lethal)\b/,
  /\bhow much (?:\w+ ){0,2}(?:is|would be) (?:a )?(?:lethal|fatal) (?:dose|amount)\b/,
  /\b(?:bridge|building|roof) (?:is )?(?:high|tall) enough to (?:die|kill me|not survive|end it)\b/,
  /\bi (?:am|m) going to take all (?:of )?my (?:pills|tablets|meds|medication)\b/,
  /\bi want to starve myself\b/,
];

export function isSelfHarmIntent(text: string): boolean {
  const { unjoined } = fold(text, { leet: true, stretch: 1 });
  return intent.some((p) => p.test(unjoined));
}
