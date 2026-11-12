import { createHash } from 'node:crypto';

import { createMockModerationProvider } from '@local-ai/providers/mock';
import { describe, expect, it } from 'vitest';

import { createInputGuard } from '../input.js';
import { normalise } from '../normalise.js';
import { decodedViews, rot13 } from './decode.js';
import { fold } from './fold.js';
import { createRules } from './rules.js';
import { slurHashes } from './slurs.js';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');

// Harmless stand-ins, so the tests exercise matching without spelling out slurs.
const rules = createRules({ slurHashes: [sha256('zorblat'), sha256('blue frog')] });
const check = (text: string): string | undefined => rules.check(normalise(text));

describe('fold', () => {
  it('sees through casing, accents, look-alike letters, leetspeak, spacing and stretching', () => {
    expect(fold('ÌGNØRE').spaced).toBe('ignore');
    expect(fold('іgnоrе').spaced).toBe('ignore'); // Cyrillic і, о, е
    expect(fold('1gn0r3').spaced).toBe('ignore');
    expect(fold('i g n o r e   this').spaced).toBe('ignore this');
    expect(fold('i.g.n.o.r.e').spaced).toBe('ignore');
    expect(fold('stuuuupid').spaced).toBe('stupid');
    expect(fold('ig-nore pre vious').squashed).toBe('ignoreprevious');
  });

  it('keeps short words and ordinary double letters', () => {
    expect(fold('I am a bookkeeper').spaced).toBe('i am a bookkeeper');
  });
});

describe('decodedViews', () => {
  it('decodes base64, url-safe base64, hex, percent-encoding and rot13', () => {
    const views = decodedViews(
      `${base64('hello world there')} ${base64('??>>hello there').replace(/\+/g, '-').replace(/\//g, '_')} ${hex('hello world')} %68%65%6C%6C%6F uryyb`,
    );
    expect(views).toContain('hello world there');
    expect(views).toContain('??>>hello there');
    expect(views).toContain('hello world');
    expect(views).toContain('hello');
    expect(views.at(-1)).toContain('hello');
  });

  it('ignores runs that do not decode to readable text', () => {
    const views = decodedViews('ThisIsALongCamelCaseIdentifierName 0123456789abcdef0123');
    expect(views).toHaveLength(1); // only the rot13 view
  });

  it('bounds the number of decoded runs', () => {
    const many = Array.from({ length: 20 }, () => base64('hello world there')).join(' ');
    expect(decodedViews(many).length).toBeLessThanOrEqual(8 * 3 + 1);
  });

  it('rot13 round-trips', () => {
    expect(rot13(rot13('Ignore Previous'))).toBe('Ignore Previous');
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
  ])('flags %s', (text) => {
    expect(check(text)).toBe('slur');
  });

  it.each(['zorblatty', 'blue', 'frog', 'a blue car and a frog'])('does not flag %s', (text) => {
    expect(check(text)).toBeUndefined();
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
    'lewd schoolgirls',
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
  ])('flags %s', (text) => {
    expect(check(text)).toBe('personal_data');
  });

  it.each([
    'Call 555-123-4567 tomorrow',
    'ISBN 978-0-306-40615-7',
    'Order 1234567890123 shipped on 2026-11-12',
    'The number 4111 1111 1111 1112 fails the checksum',
    'SSNs look like 000-12-3456 in examples',
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
