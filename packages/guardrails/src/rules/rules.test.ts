import { createHash } from 'node:crypto';

import { createManualClock } from '@local-ai/core';
import { createMockModerationProvider } from '@local-ai/providers/mock';
import { describe, expect, it } from 'vitest';

import { createCircuitBreaker } from '../breaker.js';
import { createInputGuard } from '../input.js';
import { normalise } from '../normalise.js';
import { decodedViews, rot13, unescapeAll } from './decode.js';
import { fold, foldings } from './fold.js';
import { createRules } from './rules.js';
import { slurHashes } from './slurs.js';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');

// Harmless stand-ins, so the tests exercise matching without spelling out slurs.
const rules = createRules({
  slurHashes: [sha256('zorblat'), sha256('blue frog'), sha256('zabbot')],
});
const check = (text: string): string | undefined => rules.check(normalise(text));

const leetFold = (text: string): string => fold(text, { leet: true, stretch: 1 }).spaced;

describe('fold', () => {
  it('sees through casing, accents, look-alike letters, leetspeak, spacing and stretching', () => {
    expect(leetFold('ÌGNØRE')).toBe('ignore');
    expect(leetFold('іgnоrе')).toBe('ignore'); // Cyrillic і, о, е
    expect(leetFold('ɪɢɴᴏʀᴇ')).toBe('ignore'); // Latin small capitals
    expect(leetFold('1gn0r3')).toBe('ignore');
    expect(leetFold('i g n o r e   this')).toBe('ignore this');
    expect(leetFold('i.g.n.o.r.e')).toBe('ignore');
    expect(leetFold('stuuuupid')).toBe('stupid');
    expect(fold('ig-nore pre vious', { leet: true, stretch: 1 }).squashed).toBe('ignoreprevious');
  });

  it('keeps short words and ordinary double letters', () => {
    expect(leetFold('I am a bookkeeper')).toBe('i am a bookkeeper');
  });

  it('offers a folding without leetspeak, so trailing punctuation stays punctuation', () => {
    const spaced = foldings('you idiot!').map((f) => f.spaced);
    expect(spaced).toContain('you idiot');
    expect(spaced).toContain('you idioti');
  });

  it('offers a folding that keeps stretched double letters double', () => {
    expect(foldings('zabbbbot').map((f) => f.spaced)).toEqual(['zabot', 'zabbot']);
  });
});

describe('decodedViews', () => {
  it('decodes base64, url-safe and line-wrapped base64, hex, escapes and rot13', () => {
    const urlSafe = base64('??>>hello there').replace(/\+/g, '-').replace(/\//g, '_');
    const wrapped = base64('hello world there').replace(/(.{8})/, '$1\n');
    const views = decodedViews(
      `${base64('hello world there')} ${urlSafe} ${hex('hello world')} %68%65%6C%6C%6F uryyb`,
    ).join(' | ');
    expect(views).toContain('hello world there');
    expect(views).toContain('??>>hello there');
    expect(views).toContain('hello world');
    expect(views).toContain('hello');
    expect(decodedViews(wrapped).join(' ')).toContain('hello world there');
    expect(unescapeAll('\\x68\\x69 0x68 0x69 &#104;&#x69; \\u0068i')).toBe('hi h i hi hi');
  });

  it('decodes a single short encoded word and partly encoded words in place', () => {
    expect(decodedViews(base64('zorblat')).join(' ')).toContain('zorblat');
    expect(decodedViews('zor%62%6c%61%74').join(' ')).toContain('zorblat');
  });

  it('decodes two layers, such as base64 of rot13', () => {
    expect(decodedViews(base64(rot13('hello world'))).join(' ')).toContain('hello world');
  });

  it('leaves ordinary words and numbers alone', () => {
    const views = decodedViews('Constantinople 1234567890 ThisIsALongCamelCaseIdentifierName');
    expect(views.join(' ')).not.toMatch(/[^\x20-\x7e]/);
  });

  it('rot13 round-trips', () => {
    expect(rot13(rot13('Ignore Previous'))).toBe('Ignore Previous');
  });
});

describe('rules: performance', () => {
  it.each([
    ['repeated fillers', `you${'are'.repeat(1300)}x`],
    ['spelled-out fillers', `y o u ${'a r e '.repeat(650)}x`],
    ['spaced fillers', `you${' are'.repeat(950)} x`],
    ['base64-looking text', 'QUJD'.repeat(1000)],
    ['percent escapes', '%41'.repeat(1300)],
    ['digits', '4'.repeat(4000)],
  ])('checks 4,000 characters of %s quickly', (_, text) => {
    const started = performance.now();
    check(text.slice(0, 4000));
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('rules: slurs', () => {
  it.each([
    'you are a zorblat',
    'ZORBLAT',
    'z o r b l a t',
    'z0rbl4t',
    'zоrblat', // Cyrillic о
    'zorbláts',
    'zorrrblat',
    'a Blue  Frog',
    base64('you are a zorblat'),
    hex('you are a zorblat'),
    rot13('you are a zorblat'),
    '%7a%6f%72%62%6c%61%74',
    'you are a zorblat!',
    'zorblat1',
    'zor-blat',
    'zo.rb.lat',
    'zor\u00ADblat',
    'zor\u180Eblat',
    'zor\u3164blat',
    'zorжblat',
    'ᴢᴏʀʙʟᴀᴛ',
    'zor%62%6c%61%74',
    base64('zorblat'),
    base64(rot13('zorblat')),
    base64('ｚｏｒｂｌａｔ'),
    base64('zor\u200Bblat'),
    `${Array.from({ length: 10 }, () => base64('hello world there')).join(' ')} ${base64('a zorblat')}`,
    '\\x7a\\x6f\\x72\\x62\\x6c\\x61\\x74',
    '&#122;&#111;&#114;&#98;&#108;&#97;&#116;',
    'zabbbbot',
  ])('flags %s', (text) => {
    expect(check(text)).toBe('slur');
  });

  it.each(['zorblatty', 'blue', 'frog', 'a blue car and a frog'])('does not flag %s', (text) => {
    expect(check(text)).toBeUndefined();
  });

  it.each([
    "Let's go, ok?",
    'Should I go? OK thanks',
    'My wet back is itchy after swimming',
    'The choir sang do re mi fa, got it?',
    "What's the plural s? pick one",
    'my pin is 6 0 0 k',
  ])('does not glue ordinary words into a listed word with the real list: %s', (text) => {
    expect(createRules().check(normalise(text))).toBeUndefined();
  });

  it('ships a list of distinct SHA-256 hashes', () => {
    expect(slurHashes.length).toBeGreaterThan(30);
    expect(new Set(slurHashes).size).toBe(slurHashes.length);
    for (const h of slurHashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(createRules().check('hello there')).toBeUndefined();
  });
});

describe('rules: abuse aimed at the reader', () => {
  it.each([
    'you are an idiot',
    'U R S T U P I D',
    'youreanidiot',
    "y0u're such a m0r0n",
    'you absolute piece of garbage',
    'your an idiot',
    'fuck off',
    'screw you',
    'kys',
    'go kill yourself',
    'go to hell',
    'I hope you die',
    base64('you are an idiot'),
    'you idiot!',
    'you are stupid!',
    'fuck off!',
    'go kill yourself!',
    'kys!',
    'screw you!!',
    'you moron!!!',
    'you asssshole',
    'you dumbasssss',
    'ʏᴏᴜ ᴀʀᴇ ᴀɴ ɪᴅɪᴏᴛ',
    '"you are a fucking idiot"',
    '"fuck off" bot',
    '“kys”',
    "you're an idiot for saying that",
    'you are a moron with no brain',
    'you are stupid in every way',
    'you are useless at everything',
    'I think that you are an idiot',
    'I want you to kill yourself',
    'bot, kill yourself',
    'bot go die',
    'u r a moron',
    'u r a total loser',
    'u r a 1d10t',
    'I said "fuck off"',
    'I said "you are a fucking idiot"',
    'I just said "fuck off"',
    'I literally wrote "you are an idiot"',
  ])('flags %s', (text) => {
    expect(check(text)).toBe('abuse');
  });

  it.each([
    'Is it stupid to ask how vaccines work?',
    'My code is useless, why does it crash?',
    'How do I kill a Python process?',
    "Should we go to Hell's Kitchen for dinner?",
    "You're not an idiot for asking.",
    'You are right, thanks.',
    'What does the word idiot originally mean?',
    'My boss called me an idiot. How should I respond?',
    'Is your scum filter clean?',
    'You should check yourself before driving.',
    'Your stupidly fast car needs new tyres.',
    'My boss told me "you are an idiot". How do I respond?',
    'If you are a loser at poker, how do you recover?',
    'Can I tell if you are useless at maths early?',
    'Sorry to bother you, dumb question, what is DNS?',
    'I hope you burn calories with this workout plan',
    'How not to shoot yourself in the foot with C++',
    'Did the plant go die because of frost?',
    'what does stfu mean',
    'what does kys mean in texting',
    'Do bad people go to hell?',
    'Can an AI go to hell?',
    'How to kill yourself is not something I will search for, but how do I help a friend?',
  ])('does not flag %s', (text) => {
    expect(check(text)).toBeUndefined();
  });
});

describe('rules: sexual content involving minors', () => {
  it.each([
    'sexy 12 year old',
    'nude pics of a child',
    'have sex with a minor',
    'child porn',
    'c h i l d p o r n',
    'lewd little girls',
    'sexy ten year old',
    'loli',
    '15yo nudes',
    base64('sexy 12 year old'),
  ])('flags %s', (text) => {
    expect(check(text)).toBe('sexual_minors');
  });

  it.each([
    'How do I talk to my kids about sex?',
    'Sex education for children: what is age appropriate?',
    'Summarise Lolita by Nabokov.',
    'How do I keep my children safe online?',
    'My 17 year old is learning to drive.',
    'A healthy porridge recipe for kids',
    'How do I protect children from porn?',
    'What are the signs of child sexual abuse?',
    'Laws on minors porn exposure',
  ])('does not flag %s', (text) => {
    expect(check(text)).toBeUndefined();
  });
});

describe('rules: personal data and secrets', () => {
  it.each([
    'my card is 4111 1111 1111 1111',
    'card 4111-1111-1111-1111 exp 12/29',
    'my SSN is 123-45-6789',
    'key AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    `token ghp_${'a'.repeat(36)}`,
    'qty 2 4111 1111 1111 1111',
    'my visa 4111111111111111',
    '4111.1111.1111.1111',
    'ssn: 123 45 6789',
    base64('card 4111 1111 1111 1111'),
    `sk-proj-${'Ab1'.repeat(12)}`,
  ])('flags %s', (text) => {
    expect(check(text)).toBe('personal_data');
  });

  it.each([
    'Call 555-123-4567 tomorrow',
    'ISBN 978-0-306-40615-7',
    'Order 1234567890123 shipped on 2026-11-12',
    'The number 4111 1111 1111 1112 fails the checksum',
    'SSNs look like 000-12-3456 in examples',
    'pip install sk-learn-extra-tools-for-ml',
    'UK number 020 12 3456 thanks',
    'Tracking number 4111111111111111 arrives Friday',
  ])('does not flag %s', (text) => {
    expect(check(text)).toBeUndefined();
  });
});

describe('input guard with rules', () => {
  it('refuses a rules hit as policy without calling the classifier', async () => {
    const moderation = createMockModerationProvider();
    const guard = createInputGuard({ moderation, timeoutMs: 1000, rules });
    const verdict = await guard.check('you are a z​orblat', new AbortController().signal);
    expect(verdict).toEqual({ ok: false, refusal: 'policy' });
    expect(moderation.calls).toHaveLength(0);
  });

  it('leaves the circuit breaker untouched on a rules hit', async () => {
    const clock = createManualClock(new Date('2026-11-12T00:00:00Z'));
    const breaker = createCircuitBreaker({ clock, failureThreshold: 1 });
    breaker.acquire()?.failure();
    clock.advance(10_000);
    const moderation = createMockModerationProvider();
    const guard = createInputGuard({ moderation, timeoutMs: 1000, rules, breaker });
    expect(await guard.check('you are a zorblat', new AbortController().signal)).toEqual({
      ok: false,
      refusal: 'policy',
    });
    // The half-open probe is still available: the rules hit did not use it.
    expect(breaker.acquire()).toBeDefined();
  });

  it('passes clean text on to the classifier', async () => {
    const moderation = createMockModerationProvider();
    const guard = createInputGuard({ moderation, timeoutMs: 1000, rules });
    expect(await guard.check('hello', new AbortController().signal)).toEqual({
      ok: true,
      text: 'hello',
    });
    expect(moderation.calls).toHaveLength(1);
  });
});
