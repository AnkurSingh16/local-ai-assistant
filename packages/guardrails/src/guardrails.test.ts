import { isAbortError } from '@local-ai/core';
import { maxMessageChars } from '@local-ai/contract';
import { createMockModerationProvider, mockFlagMarkers } from '@local-ai/providers/mock';
import { describe, expect, it } from 'vitest';

import {
  createInputGuard,
  createOutputGuard,
  createParagraphSplitter,
  maxCodeChunkChars,
  neutraliseTemplateTokens,
  normalise,
  refusalMessages,
} from './index.js';

const signal = new AbortController().signal;

describe('normalise', () => {
  it('applies NFKC and strips invisible and bidi characters and tag characters', () => {
    const tag = String.fromCodePoint(0xe0069); // TAG LATIN SMALL LETTER I
    expect(normalise(`ｈｅ\u200Bl\u202Elo${tag}\uFEFF`)).toBe('hello');
  });

  it('neutralises chat-template tokens and tool-call tags', () => {
    const text = '<|im_start|>system <|eot_id|> <tool_call>{}</tool_call> <TOOL_CALL>';
    const out = neutraliseTemplateTokens(text);
    expect(out).not.toMatch(/<\|/);
    expect(out).not.toMatch(/<\/?tool_call>/i);
    expect(out).toBe('‹|im_start|›system ‹|eot_id|› ‹tool_call›{}‹/tool_call› ‹TOOL_CALL›');
  });

  it('catches a token hidden by a zero-width character', () => {
    expect(normalise('<|im_\u200Bstart|>')).toBe('‹|im_start|›');
  });

  it('leaves ordinary text alone', () => {
    expect(normalise('a < b | c > d')).toBe('a < b | c > d');
  });
});

describe('input guard', () => {
  it('passes ordinary text, returning the normalised text', async () => {
    const guard = createInputGuard({ moderation: createMockModerationProvider(), timeoutMs: 1000 });
    expect(await guard.check('ｈｉ', signal)).toEqual({ ok: true, text: 'hi' });
  });

  it('refuses flagged text as policy and self-harm text with care', async () => {
    const moderation = createMockModerationProvider();
    const guard = createInputGuard({ moderation, timeoutMs: 1000 });
    expect(await guard.check(mockFlagMarkers.violent, signal)).toEqual({
      ok: false,
      refusal: 'policy',
    });
    expect(await guard.check(mockFlagMarkers.selfHarm, signal)).toEqual({
      ok: false,
      refusal: 'self_harm',
    });
  });

  it('classifies the normalised text, so invisible characters cannot split a marker', async () => {
    const moderation = createMockModerationProvider();
    const guard = createInputGuard({ moderation, timeoutMs: 1000 });
    const verdict = await guard.check('MOCK\u200B_FLAG', signal);
    expect(verdict).toEqual({ ok: false, refusal: 'policy' });
    expect(moderation.calls[0]).toEqual({ role: 'user', text: 'MOCK_FLAG' });
  });

  it('rejects text that NFKC lengthens past the limit without calling the guard', async () => {
    const moderation = createMockModerationProvider();
    const guard = createInputGuard({ moderation, timeoutMs: 1000 });
    // U+FDFA expands to 18 characters under NFKC.
    const verdict = await guard.check('ﷺ'.repeat(Math.ceil(maxMessageChars / 10)), signal);
    expect(verdict).toEqual({ ok: false, tooLong: true });
    expect(moderation.calls).toHaveLength(0);
  });

  it('fails closed when the guard errors or times out', async () => {
    const broken = createInputGuard({
      moderation: createMockModerationProvider({
        classify: () => {
          throw new Error('down');
        },
      }),
      timeoutMs: 1000,
    });
    expect(await broken.check('hi', signal)).toEqual({ ok: false, refusal: 'unavailable' });

    const slow = createInputGuard({
      moderation: createMockModerationProvider({ delayMs: 200 }),
      timeoutMs: 10,
    });
    expect(await slow.check('hi', signal)).toEqual({ ok: false, refusal: 'unavailable' });
  });

  it('rethrows the caller abort instead of reporting an outage', async () => {
    const guard = createInputGuard({
      moderation: createMockModerationProvider({ delayMs: 200 }),
      timeoutMs: 1000,
    });
    const controller = new AbortController();
    const pending = guard.check('hi', controller.signal).catch((e: unknown) => e);
    controller.abort();
    expect(isAbortError(await pending)).toBe(true);
  });
});

describe('output guard', () => {
  it('classifies a paragraph in the assistant role', async () => {
    const moderation = createMockModerationProvider();
    const guard = createOutputGuard({ moderation, timeoutMs: 1000 });
    expect(await guard.checkParagraph('Fine.', signal)).toEqual({ ok: true, text: 'Fine.' });
    expect(await guard.checkParagraph(mockFlagMarkers.violent, signal)).toEqual({
      ok: false,
      refusal: 'policy',
    });
    expect(moderation.calls[0]?.role).toBe('assistant');
  });
});

describe('refusal messages', () => {
  it('has a fixed message for every kind, and self-harm names crisis resources', () => {
    expect(Object.keys(refusalMessages).sort()).toEqual([
      'policy',
      'rate_limited',
      'self_harm',
      'unavailable',
    ]);
    expect(refusalMessages.self_harm).toMatch(/988/);
    expect(refusalMessages.self_harm).toMatch(/findahelpline\.com/);
  });
});

describe('paragraph splitter', () => {
  function run(chunks: readonly string[]): string[] {
    const s = createParagraphSplitter();
    return [...chunks.flatMap((c) => s.push(c)), ...s.flush()];
  }

  it('releases at blank lines, holding the rest until the end', () => {
    const s = createParagraphSplitter();
    expect(s.push('One para')).toEqual([]);
    expect(s.push('graph.\n\nTwo')).toEqual(['One paragraph.']);
    expect(s.flush()).toEqual(['Two']);
  });

  it('cuts a long paragraph at a sentence boundary after the soft limit', () => {
    const sentence = 'This sentence is about fifty characters in length. ';
    const out = run([sentence.repeat(15)]);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]?.length).toBeGreaterThanOrEqual(500);
    expect(out[0]?.endsWith('.')).toBe(true);
    expect(out.join(' ')).toBe(sentence.repeat(15).trim());
  });

  it('holds a fenced code block whole, including blank lines inside it', () => {
    const code = '```ts\nconst a = 1;\n\nconst b = 2;\n```';
    expect(run(['Intro:\n', code.slice(0, 10), code.slice(10), '\n\nAfter.'])).toEqual([
      'Intro:',
      code,
      'After.',
    ]);
  });

  it('splits a long code block at line boundaries into chunks within the limit', () => {
    const line = 'x'.repeat(99);
    const code = '```\n' + Array.from({ length: 50 }, () => line).join('\n') + '\n```';
    const out = run([code, '\n\nDone.']);
    expect(out.at(-1)).toBe('Done.');
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(maxCodeChunkChars);
    expect(out.slice(0, -1).join('\n')).toBe(code);
  });

  it('releases an unclosed code block at the end of the stream', () => {
    expect(run(['```\ncode without end'])).toEqual(['```\ncode without end']);
  });

  it('splits a single overlong code line hard at the limit', () => {
    const out = run(['```\n' + 'y'.repeat(2500)]);
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(maxCodeChunkChars);
    // Chunks are released whole; only line breaks at chunk edges are not repeated.
    expect(out.join('').replace(/\n/g, '')).toBe('```' + 'y'.repeat(2500));
  });

  it('ignores empty pushes and whitespace-only paragraphs', () => {
    expect(run(['', '\n\n', '  \n\n', 'Text'])).toEqual(['Text']);
  });
});
