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

/**
 * A question asking for facts, as opposed to a request to explain, write or
 * change something. A time word only forces search inside a question.
 */
const factualQuestion =
  /^(?:\W*)(?:what(?:'s| is| are| was| were| did| does| do| time| films?| movies?)?|who(?:'s| is| are| won| runs| leads)?|when|where|which|is|are|was|were|did|does|do|will|has|have|had|any|how (?:much|many|is|are|did|does|do|\w+ (?:is|are|was|were|will))|can i (?:still )?(?:buy|get|watch|see))\b/;
/** Requests to explain or produce something, which a time word does not make news. */
const request =
  /^(?:\W*)(?:(?:can|could|would) you (?:please )?)?(?:explain|write|help|tell me (?:a|about how)|show|teach|describe|define|summarise|summarize|translate|fix|review|rewrite)\b/;
/** Questions about the clock or calendar, which get_current_datetime answers without search. */
const clockQuestion =
  /\b(?:what(?:'s| is) (?:the )?(?:time|date|day)(?: it)?(?: is it)?|what(?:'s| is) today's (?:date|day)|what day is it|what date is it|what time is it|how many (?:days|weeks|months) (?:until|till|to|since))\b/;
/** Time words that make a factual question about now or the near future. */
const nearTime =
  /\b(?:today|tonight|tomorrow|yesterday|last night|this (?:morning|afternoon|evening|week|weekend|month|year|season)|right now|at the moment|these days|nowadays|so far|as of now|now(?=\s*(?:[?.!,;]|$))|(?<!\b(?:i'm|i am|i|we're|we are|they're|it's|it is) )currently(?! (?:use|uses|using|run|runs|running|on|have|has|installed|working)\b)|latest(?! (?:i|you|we|time|hour)\b)|newest|most recent|upcoming|next (?:week|month|year|weekend)|recently)\b/;
/** Things still pending or scheduled: "is it out yet", "when is the next launch". */
const pendingOrNext =
  /\b(?:yet|when (?:is|are|does|do|will) (?:the )?next|what(?:'s| is) next for|next (?:launch|race|match|game|episode|season|election|eclipse|release|event|movie|film))\b/;
/** Who holds a role, however it is asked. */
const whoLeads =
  /\bwho (?:runs|leads|heads|owns|is in charge of|chairs|coaches|manages)\b|\b(?:secretary[- ]general|chief executive|head coach|frontrunner|leader of the opposition)\b/;
/** Live state that is public by nature: weather, rates, results, outages, availability. */
const publicLiveState =
  /\b(?:exchange rate|convert \d[\d,.]* ?(?:[a-z]{3}|dollars?|euros?|pounds?|yen|rupees?) (?:to|into)|how many (?:dollars|euros|pounds|yen|rupees) is|storm warning|weather|forecast|snowing|raining|sunny|how (?:hot|cold|warm) will|who (?:scored|won)|election results?|outage|is (?:\w+ )?down (?:right now|today)|on sale|in stock|sold out|flights? (?:from|to)|tickets? (?:for|to)|updates? (?:on|about)|news (?:on|about))\b/;
/**
 * Words that ask about now only when they are about something public: "how
 * expensive is Netflix" yes, "how expensive is it to learn piano" no. They force
 * search only next to a time word or a named thing.
 */
const weakLiveState =
  /\b(?:costs?|prices?|pricing|expensive|cheapest|cheaper|(?:interest|mortgage|inflation) rates?|temperature|still|has (?:[\w' ]{1,40} )?(?:come out|been released|launched|held|ended|started|finished|changed)|delays?|cancell?ed|closed)\b/;
/** A question addressed to the assistant ("how are you feeling today?"): small talk, never searched. */
const toAssistant = /\b(?:you|your|you're|yourself)\b/;
/** Polite wrappers ("can you tell me who won?") ask for facts, not about the assistant. */
const politeWrapper =
  /\b(?:can|could|would|will) you (?:please )?(?:tell me|find out|check|look up|let me know)\b|\bdo you know\b/g;

/**
 * Distress in any part of the message ("…tonight? I want to disappear").
 * Such a turn is never searched: a search would hand opening times or routes
 * to someone who may be at risk, and the query prompt would strip the warning
 * sign out. The guard answers the clear cases with crisis resources; this
 * catches vaguer ones it lets through (#57 review).
 */
const distress =
  /\b(?:(?:don't|do not) want to (?:be here|live|exist)|want (?:it all|everything|my life|the pain) to (?:end|stop)|(?:nobody|no one) (?:would|will|'d) (?:even )?(?:miss|notice|care)|cannot go on|want to (?:disappear|die|vanish|not exist)|(?:not|never) (?:to )?wake up|done with (?:everything|it all|life)|can't (?:go on|take (?:it|this) anymore|do this anymore)|end (?:it all|everything)|no reason to (?:live|go on)|better off (?:dead|without me)|give up on (?:life|everything)|kill myself|hurt myself|self-harm|suicid\w*|overdose)\b/;

/** The user or people around them, by pronoun. "us" is checked on the original text, so "the US" is not. */
const personPronoun =
  /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|myself|we|we're|our|he|she|him|her|his|hers|they're|their)\b/;

/**
 * Health, relationships, feelings and personal legal, work or money matters.
 * Asked about a person, these stay local: a forced query paraphrases the
 * message, so it would carry private context ("is my lump still worth
 * checking", "has Priya's chemo started working") to a search engine. Measured
 * on the routing eval's personal batches (ADR-0003, #57).
 */
const privateTopic =
  /\b(?:pain|ache|lump|rash|fever|cough|symptoms?|diagnos\w*|chemo\w*|cancer|tumou?r|pregnan\w*|period|contagious|infect\w*|surgery|operation|wound|bleeding|injur\w*|sprain\w*|broken (?:wrist|arm|leg|bone|ankle)|knee|blood (?:pressure|test)|temperature (?:of|is|too)|memory loss|medic(?:ation|ine)s?|tablets|pills?|antibiotics?|antidepressants?|inhaler|booster|vaccin\w*|therapy|therapist|anxiety|panic attacks?|depress\w*|allerg\w*|dose|prescription|doctor|gp|hospital|heal(?:ed|ing)?|recover\w*|love|feelings for|ex|boyfriend|girlfriend|husband|wife|partner|divorce\w*|married|marriage|separated|breakup|break-up|upset|angry|argument|grounded|curfew|lonely|grief|left home alone|visa|deposit|landlord|tenant|eviction|rights to|custody|probation|holiday pay|sick pay|owed|salary|fired|resign\w*|hr|boss|eligible|qualify|claim|benefits?|grant|school meals|application|refund|receipt|return (?:the|her|his|my)|still good|bull(?:y|ied|ying)|dementia|alzheimer'?s?|ivf|fertility|miscarriage|abortion|hiv|std|sti|clinic|rehab|addiction|relapse|sober|prison|jail|arrested|court case|probation officer|asylum|immigration status|deport\w*|overdrawn|debt|bankrupt\w*|loan|evicted|homeless|food bank|nothing to eat|gay|lesbian|bisexual|trans(?:gender)?|coming out|sexuality|suicid\w*|kill (?:myself|himself|herself)|jump off|end (?:my|his|her) life|self-harm|hurt (?:myself|himself|herself)|overdose|sad|cheer (?:me )?up|feel(?:ing)? (?:down|low)|mood|(?:my|our) (?:department|company|office|school|class|family|workplace|manager|boss))\b/;

/** A person named, by a capitalised name or a possessive such as "Priya's". */
function namesPerson(message: string): boolean {
  return namesSomething(message) || /\b[A-Z][a-z]+'s\b/.test(message.replace(/[‘’ʼ]/g, "'"));
}

/**
 * True for a question that must stay local: one addressed to the assistant, or
 * one about a person on a private topic. A pronoun alone no longer makes a
 * question private, so "who won the final? I missed it" can still be searched.
 */
function isPrivate(message: string, text: string): boolean {
  if (distress.test(text)) return true;
  if (toAssistant.test(text.replace(politeWrapper, ''))) return true;
  const person = personPronoun.test(text) || /\bus\b/.test(message) || namesPerson(message);
  return person && privateTopic.test(text);
}

/** Clauses of a message, so a question that follows a statement is still found. */
function clauses(text: string): string[] {
  return text.split(/[.?!;]\s+|,\s+/).map((c) => c.trim());
}

/** A capitalised word after the first, other than "I": a named product, place, team or person. */
function namesSomething(message: string): boolean {
  const words = message.replace(/[‘’ʼ]/g, "'").split(/\s+/);
  // A capital that only starts a new sentence ("…eat? The rice was out") is not a name.
  return words.some(
    (w, i) =>
      i > 0 &&
      !/[.?!]$/.test(words[i - 1] ?? '') &&
      /^[A-Z][\w'.-]*[a-zA-Z]/.test(w) &&
      !/^I(?:'\w+)?$/.test(w),
  );
}

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
 * with something that changes, a recent year, or a factual question about the
 * world that asks about now, what comes next, or the live state of something
 * named. Questions about the user or the assistant, "what is a stock",
 * "explain how elections work" and fiction set in a recent year are not forced.
 */
export function isTimeSensitive(message: string, now: Date): boolean {
  const text = message.toLowerCase().replace(/[‘’ʼ]/g, "'");
  if (aboutAText.test(text)) return false;
  // Private questions stay local under every rule (see isPrivate).
  if (isPrivate(message, text)) return false;
  if (currentRoles.test(text)) return true;
  if (alwaysChanging.test(text)) return true;
  if (!creativeRequest.test(text) && mentionsRecentYear(text, now.getUTCFullYear())) return true;
  if (timeWords.test(text) && changingThings.test(text)) return true;
  // Broader rules, measured on the routing eval (ADR-0003), for factual
  // questions about the world.
  const question =
    clauses(text).some((c) => factualQuestion.test(c) && !request.test(c)) &&
    !clockQuestion.test(text);
  if (question) {
    const timeOrName = nearTime.test(text) || namesSomething(message);
    if (publicLiveState.test(text)) return true;
    if (nearTime.test(text)) return true;
    if (timeOrName && (pendingOrNext.test(text) || whoLeads.test(text))) return true;
    if (timeOrName && weakLiveState.test(text)) return true;
  }
  // Price words about a named product ask about now even outside a question.
  if (namesSomething(message) && /\b(?:cheapest|best price|price of|prices? for)\b/.test(text)) {
    return true;
  }
  return /\b(?:latest|today's|current) (?:news|price|score|version|release|results?|weather)\b/.test(
    text,
  );
}
