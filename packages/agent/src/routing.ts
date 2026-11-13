/**
 * The search pre-router (ADR-0003). A turn that asks about something that may
 * have changed since the model's training is searched before generation, and
 * the model cannot skip it. Other turns may still search if the model calls the
 * tool. A pure function of the message and the current year, so it is
 * unit-tested directly.
 */

/** qwen2.5's training data runs into 2024; anything from then on may be news to it. */
export const trainingCutoffYear = 2024;

const timeWords =
  /\b(?:current(?:ly)?|latest|newest|most recent|recent(?:ly)?|today|tonight|tomorrow|yesterday|this (?:week|month|year|morning|evening|weekend|season)|right now|as of now|these days|nowadays|upcoming|so far this)\b/;
const changingThings =
  /\b(?:price|prices|cost of|exchange rate|stock|share price|weather|forecast|score|scores|standings|results?|who won|winner|election|polls?|news|headlines|release date|released|launch(?:ed)?|version|update|outage|traffic|schedule|fixtures)\b/;
const currentRoles =
  /\bwho (?:is|s|are) (?:the )?(?:current |new )?(?:ceo|president|prime minister|chancellor|king|queen|pope|mayor|governor|leader|head|chair(?:man|woman|person)?|owner|coach|captain|manager)\b/;

/** Years from the training cutoff on, written as four digits. */
function mentionsRecentYear(text: string, currentYear: number): boolean {
  for (const match of text.matchAll(/\b(20\d\d)\b/g)) {
    const year = Number(match[1]);
    if (year >= trainingCutoffYear && year <= currentYear + 1) return true;
  }
  return false;
}

/**
 * True when the turn must search first. Needs either a time word with
 * something that changes, a question about who holds a role now, or a recent
 * year, so "what is a stock" or "explain how elections work" are not forced.
 */
export function isTimeSensitive(message: string, now: Date): boolean {
  const text = message.toLowerCase();
  if (currentRoles.test(text)) return true;
  if (mentionsRecentYear(text, now.getUTCFullYear())) return true;
  if (timeWords.test(text) && changingThings.test(text)) return true;
  return /\b(?:latest|today'?s|current) (?:news|price|score|version|release|results?|weather)\b/.test(
    text,
  );
}
