/**
 * The search pre-router (ADR-0003). A turn that asks about something that may
 * have changed since the model's training is searched before generation, and
 * the model cannot skip it. Other turns may still search if the model calls the
 * tool. A pure function of the message and the current year, so it is
 * unit-tested directly.
 */

/** qwen2.5's training data runs into 2024; anything from then on may be news to it. */
export const trainingCutoffYear = 2024;

// "Currently" about the user's own setup ("I'm currently on Python 3.11", "my app
// currently uses React 2") is not a question about now. "Now" counts only at the
// end of a clause ("who is the president now?"), not as "now update the function".
const timeWords =
  /\b(?:(?<!\b(?:i'm|i am|i|we're|we are|they're|it's|it is) )current(?:ly)?(?! (?:use|uses|using|run|runs|running|on|have|has|installed|working)\b)|latest|newest|most recent|recent(?:ly)?|today|tonight|tomorrow|yesterday|last night|this (?:week|month|year|morning|evening|weekend|season)|right now|as of now|now(?=\s*(?:[?.!,;]|$))|these days|nowadays|upcoming|so far this)\b/;
const changingThings =
  /\b(?:price|prices|cost|costs|exchange rate|stock|share price|weather|forecast|score|scores|standings|results?|who won|winner|election|polls?|news|headlines|release date|released|launch(?:ed)?|version|update|outage|traffic|schedule|fixtures)\b/;
/** Things that change so often that asking about them at all needs fresh data. */
const alwaysChanging =
  /\b(?:(?:stock|share|bitcoin|btc|ethereum|crypto|gold|oil|petrol|gas) price|price of (?:a |an |the )?(?:bitcoin|btc|ethereum|gold|silver|oil|petrol|gas|shares?|stock)|(?:what's|what is|what are) the (?:current )?prices? of|exchange rate|weather (?:in|for|at|today|tomorrow)|forecast for|who won|final score|score of the|how much (?:does|do|is|are) (?:a |an |the )?[\w\s-]{1,40} (?:cost|costs|selling for)|newest|latest (?:version|release|model|news|update))\b/;
const currentRoles =
  /\bwho(?: is|'s| are) (?:the )?(?:current |new )?(?:ceo|president|prime minister|chancellor|king|queen|pope|mayor|governor|leader|head|chair(?:man|woman|person)?|owner|coach|captain|manager)\b/;
/**
 * Questions about a text, code or group the user points at ("in this poem",
 * "in my company"), where "who is the head" means a character or a colleague,
 * and a search would send the user's own context out. Only "this", "that" or "my": "the score of the game"
 * is a question about now.
 */
const aboutAText =
  /\b(?:in|of) (?:this|my|that) (?:poem|story|novel|book|text|passage|song|play|film|movie|show|game|essay|chapter|scene|script|code|company|team|office|school|family|workplace|class)\b/;
/** Creative writing set in a year is fiction, not a question about that year. */
const creativeRequest =
  /\b(?:write|compose|imagine|invent|draft|make up)\b.{0,60}\b(?:story|poem|song|lyrics|essay|script|scene|fiction|tale|letter|dialogue)\b/;

/** Years from the training cutoff on, written as four digits. */
function mentionsRecentYear(text: string, currentYear: number): boolean {
  for (const match of text.matchAll(/\b(20\d\d)\b/g)) {
    const year = Number(match[1]);
    if (year >= trainingCutoffYear && year <= currentYear + 1) return true;
  }
  return false;
}

/**
 * True when the turn must search first: a question about who holds a role,
 * something that always changes (a price, the weather, who won), a time word
 * with something that changes, or a recent year. "What is a stock", "explain
 * how elections work" and fiction set in a recent year are not forced.
 */
export function isTimeSensitive(message: string, now: Date): boolean {
  const text = message.toLowerCase().replace(/[‘’ʼ]/g, "'");
  if (aboutAText.test(text)) return false;
  if (currentRoles.test(text)) return true;
  if (alwaysChanging.test(text)) return true;
  if (!creativeRequest.test(text) && mentionsRecentYear(text, now.getUTCFullYear())) return true;
  if (timeWords.test(text) && changingThings.test(text)) return true;
  return /\b(?:latest|today's|current) (?:news|price|score|version|release|results?|weather)\b/.test(
    text,
  );
}
