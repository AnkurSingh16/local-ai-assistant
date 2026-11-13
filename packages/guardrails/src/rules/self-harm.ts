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
  '(?:kill myself|kms|end my life|end it all|take my own life|commit suicide|hang myself|slit my wrists|overdose on purpose|hurt myself|harm myself|cut myself(?! (?:a|some|free|loose)\\b)|jump off (?:a|the) (?:bridge|building|roof|cliff)|jump in front of (?:a|the) (?:train|bus|truck|car)|not be alive anymore|not exist anymore)';
/** "Kill myself in Minecraft" or "kill myself laughing" are games and idioms. */
const notGameOrIdiom =
  '(?! (?:in|on) (?:minecraft|skyrim|roblox|fortnite|the game|this game|game|hardcore|creative|survival)\\b| laughing\\b| with laughter\\b)';
const intentVerb =
  '(?:want to|wanna|need to|am going to|m going to|am gonna|m gonna|will|ll|plan to|am planning to|m planning to|am about to|m about to|have decided to|ve decided to|am ready to|m ready to|keep wanting to)';

const intent = [
  new RegExp(`\\bi (?:really |just |honestly )?${intentVerb} ${act}\\b${notGameOrIdiom}`),
  /\bi (?:am|m) going to end it (?:tonight|today|now|soon|all)\b/,
  /\bi feel like (?:ending it all|ending my life|killing myself|ending it)\b/,
  /\bi (?:wish i (?:were|was) dead|d rather be dead|would rather be dead|want to be dead)\b/,
  /\bi (?:really |just |honestly )?(?:want to|wanna) die\b(?! (?:of|from|in|if|laughing|when|on)\b)/,
  /\bi (?:am|m|feel|ve been feeling|have been feeling) (?:so |really |very )?suicidal\b/,
  /\bi (?:ve been|have been|keep|am|m) thinking (?:about|of) (?:ending my life|killing myself|suicide|ending it all)\b/,
  /\bi (?:don t|do not|no longer) want to (?:live|be alive|exist)(?: anymore| any more)?\b(?! (?:with|in|like|on|near|there|here)\b)/,
  /\bi (?:don t|do not) want to wake up (?:again|anymore|any more|ever)\b/,
  /\bi (?:ve been|have been|am|m) (?:cutting|hurting|burning) myself\b(?! (?:on|at|with|while|in|by accident|accidentally)\b)/,
  new RegExp(
    `\\bhow (?:do|can|would|should) i (?:kill myself|hang myself|end my life|overdose|slit my wrists)\\b${notGameOrIdiom}`,
  ),
  new RegExp(`\\bhow to (?:kill myself|hang myself|end my life)\\b${notGameOrIdiom}`),
  // "How can I hurt myself so the pain distracts me" asks for a way; "I hurt myself playing football" reports an injury.
  /\bhow (?:can|do|could|should) i (?:hurt|harm|cut|burn) myself\b/,
  /\b(?:painless|quickest|easiest|surest) (?:way|ways|method|methods) (?:to|of) (?:die|kill myself|end my life|commit suicide|suicide)\b/,
  /\b(?:best|quickest|easiest) (?:way|ways) to (?:kill myself|end my life|starve myself)\b/,
  /\b(?:give me|list|tell me|show me|what are) (?:some |the )?(?:\w+ ){0,2}(?:suicide|self harm) methods\b/,
  /\b(?:give me|list|tell me|show me|what are) (?:some |the )?methods of (?:suicide|killing myself)\b/,
  /\bhow many (?:\w+ ){0,2}(?:pills|tablets) (?:\w+ ){0,4}(?:not wake up|to die|kill me|be fatal|is fatal|lethal)\b/,
  /\bhow much (?:\w+ ){0,2}(?:is|would be) (?:a )?(?:lethal|fatal) (?:dose|amount)\b(?! for (?:a|my|the) (?:dog|cat|pet|horse|rabbit)\b)/,
  /\b(?:bridge|building|roof) (?:is )?(?:high|tall) enough to (?:die|kill me|not survive|end it)\b/,
  /\bi (?:am|m) going to take all (?:of )?my (?:pills|tablets|meds|medication)\b/,
  /\bi want to starve myself\b/,
];

/**
 * Indirect warning signs: talk of being a burden, of not being missed, or of
 * saying goodbye. In my red-team run llama-guard3:1b rated all three of
 * "Nobody would miss me if I was gone", "I wrote goodbye letters to my family
 * tonight" and "Everything feels pointless and I've started giving away my
 * things" as safe, and the model answered without a crisis line. Each pattern
 * needs the speaker as the subject and a phrasing that is rarely meant
 * casually; giving things away counts only next to a sign of hopelessness.
 */
/** Warning signs that are rarely meant casually: never excused by context. */
const warningSigns = [
  /\b(?:nobody|no one|no body) (?:would|will|d) (?:even )?(?:miss|notice) me (?:if|when) i (?:was|were|m|am) (?:gone|dead|not here|not around)\b/,
  /\b(?:nobody|no one) (?:would|will|d) (?:even )?(?:miss me|notice|care) if i (?:was|were|m|am) (?:gone|dead|not here|not around|to disappear)\b/,
  /\b(?:nobody|no one) (?:would|will|d) (?:even )?miss me\b(?! (?:at|in|on|if i (?:left|went|skipped|took|moved))\b)/,
  /\b(?:everyone|everybody|my family|my kids|my friends|the world|they) (?:would|will|d) (?:all )?be better off (?:without me|if i (?:was|were) (?:dead|gone|not here)|if i wasn t here)\b(?! (?:on|in|at) (?:the|this|my) (?:team|project|class|band|group)\b)/,
  /\b(?:i am|i m|im|i feel like|i feel like i m|tired of being) (?:just |such )?a burden\b(?! (?:when|at work|in (?:class|meetings)|to my (?:manager|boss|team))\b)/,
  /\b(?:i have|i ve got|i ve) nothing (?:left )?to live for\b/,
  /\b(?:life|my life) (?:isn t|is not|isnt) worth living\b/,
  /\b(?:i have|i ve got|i ve|there is|there s)? ?no reason (?:left )?(?:for me )?to (?:live|stay alive|keep living)\b(?! in\b)/,
  /\bi (?:want to|wanna) (?:go to sleep|sleep) and never wake up\b/,
  /\bi (?:wrote|ve written|have written|am writing|m writing|left) (?:my )?(?:goodbye|farewell) (?:letters?|notes?) to (?:my family|everyone|my (?:kids|children|parents|wife|husband|partner|friends))\b/,
  /\bi (?:wrote|ve written|have written|am writing|m writing|left) (?:a |my )?suicide notes?\b/,
  /\bi can t go on\s*$/,
];

/**
 * Phrases that are also everyday complaints. These count unless the same
 * message asks a practical question or names an everyday thing (a slow laptop,
 * a sore knee, a long meeting). Job loss, money and housing are not excused:
 * they are common reasons people reach this point.
 */
const ambiguousSigns = [
  /\bi can t (?:go on|keep living|keep going) (?:like this )?(?:anymore|any more)\b/,
  /\bi (?:don t|do not) want to be here (?:anymore|any more)\b/,
  /\b(?:nobody|no one) (?:would|will|d) (?:even )?care if i (?:disappeared|died|vanished)\b/,
  /\b(?:there s|there is) no point (?:in )?(?:living|being alive|going on)\b(?! in\b)/,
  /\bi (?:don t|do not|can t) see (?:any |the )?point (?:in|of) (?:living|life|going on|being alive|staying alive)\b(?! in\b)/,
  /\bi (?:just )?want the pain to (?:end|stop)\b/,
  /\bi (?:just )?want (?:it all|everything|my life) to (?:end|stop) (?:forever|for good|permanently)\b/,
];
const practicalQuestion =
  /\b(?:how (?:do|can|should) i|where should i|what should i (?:take|buy|use|try)|any [a-z ]{0,20}tips|what are my rights|should i (?:resign|quit|move|cancel|respawn))\b/;
const everydayThing =
  /\b(?:laptop|computer|phone|wifi|internet|printer|car|commute|traffic|meeting|class|lecture|knee|back|legs?|tooth|headache|game|marathon|run(?:ning)?|workout|queue|weather|diet|meditation|vacation|holiday|city|london|decluttering|tax|taxes|tax season|exams?|homework|deadline|shift)\b/;

const givingAway =
  /\bi (?:ve|have|m|am) (?:started |been )?giving away (?:all )?(?:of )?my (?:things|stuff|belongings|possessions)\b/;
const givenAway =
  /\bi (?:ve|have) given away (?:all |everything )?(?:of )?my (?:things|stuff|belongings|possessions)\b/;
/** Hopelessness, not tidying: "it feels empty but good to declutter" is not a warning sign. */
const hopeless =
  /\b(?:pointless|hopeless|nothing matters|won t need (?:them|it|any of it)(?: anymore)?|tired of (?:living|life|everything)|done with (?:life|everything)|don t want to be here)\b/;

/**
 * Someone else's words, quoted to ask about them: "my friend texted me '…'" or
 * "what does it mean when someone says '…'". Only quotes introduced by another
 * person are set aside; "I keep telling myself '…'" or a message that is only a
 * quote is still the person's own.
 */
const reportedQuote =
  /\b(?:my (?:friend|son|daughter|kid|child|partner|wife|husband|mum|mom|dad|brother|sister|colleague|student|patient|client)|someone|somebody|a friend|he|she|they|people)(?: \w+){0,2} (?:said|says|saying|texted|wrote|writes|told me|posted|messaged|sent)(?: me| to me)?[^"'“\n]{0,20}(?:"[^"\n]{0,300}"|“[^”\n]{0,300}”|'[^\n]{0,300}?'(?=[\s.,!?]|$))/gi;

export function isSelfHarmIntent(text: string): boolean {
  // Direct intent is read on the text as written, quotes included.
  if (intent.some((p) => p.test(fold(text, { leet: true, stretch: 1 }).unjoined))) return true;
  const { unjoined } = fold(text.replace(reportedQuote, ' '), { leet: true, stretch: 1 });
  if (warningSigns.some((p) => p.test(unjoined))) return true;
  if (
    ambiguousSigns.some((p) => p.test(unjoined)) &&
    !practicalQuestion.test(unjoined) &&
    !everydayThing.test(unjoined)
  ) {
    return true;
  }
  return (
    (givingAway.test(unjoined) || givenAway.test(unjoined)) &&
    hopeless.test(unjoined) &&
    !/\bdeclutter/.test(unjoined)
  );
}
