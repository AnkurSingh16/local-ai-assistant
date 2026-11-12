import { fold } from './fold.js';

/**
 * First-person self-harm intent, answered with care and crisis resources rather
 * than a refusal (ADR-0005). The classifier is the main layer for this, but in
 * my red-team run llama-guard3:1b rated "I'm going to jump off a bridge tonight"
 * as S1 (violent crime), which would have sent a refusal to someone at risk. A
 * false positive here costs a supportive message; a miss costs much more, so
 * this check runs before every other rule.
 *
 * It looks for the speaker's own intent or a request for methods, so questions
 * about helping someone else ("warning signs that someone might be suicidal")
 * still reach the classifier and the model.
 */
const intent = [
  /\bi (?:want|wanna|need|plan|am going|m going|am gonna|m gonna|will|ll|am about|m about|have decided|ve decided|keep thinking about how) to (?:kill myself|end my life|end it all|end it|commit suicide|take my own life|die|not be alive|hurt myself|cut myself|overdose|jump off)\b/,
  /\bi (?:wanna|gonna|m gonna) (?:die|kill myself|end it|end my life|hurt myself)\b/,
  /\bi (?:don t|do not|no longer) want to (?:live|be alive|exist|wake up)\b/,
  /\bi (?:ve been|have been|keep|am|m) (?:cutting|hurting|burning|starving) myself\b/,
  /\b(?:kill myself|end my life|take my own life|commit suicide)\b(?: \w+){0,6} (?:painless|quick|quickly|best way|easiest|tonight|today)\b/,
  /\b(?:painless|quickest|easiest|best|surest) (?:way|ways|method|methods) (?:to|of) (?:die|kill myself|end my life|commit suicide|suicide)\b/,
  /\b(?:suicide|self harm) methods?\b/,
  /\bmethods? of (?:suicide|killing myself)\b/,
  /\bhow many (?:\w+ ){0,2}(?:pills|tablets) (?:\w+ ){0,4}(?:not wake up|to die|kill me|be fatal|is fatal|lethal)\b/,
  /\b(?:which|what) (?:bridge|building) (?:is )?(?:high|tall) enough\b/,
  /\bhurt myself so\b/,
  /\bstarve myself\b/,
];

export function isSelfHarmIntent(text: string): boolean {
  const { unjoined } = fold(text, { leet: true, stretch: 1 });
  return intent.some((p) => p.test(unjoined));
}
