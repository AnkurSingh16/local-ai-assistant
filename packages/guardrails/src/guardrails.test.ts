import { isAbortError } from '@local-ai/core';
import { maxMessageChars } from '@local-ai/contract';
import { createMockModerationProvider, mockFlagMarkers } from '@local-ai/providers/mock';
import { describe, expect, it } from 'vitest';

import {
  createInputGuard,
  createOutputGuard,
  createParagraphSplitter,
  maxUnitChars,
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
    expect(refusalMessages.self_harm).toContain('988');
    expect(refusalMessages.self_harm).toContain('findahelpline.com');
  });
});

describe('paragraph splitter', () => {
  function run(chunks: readonly string[]): string[] {
    const s = createParagraphSplitter();
    return [...chunks.flatMap((c) => s.push(c)), ...s.flush()];
  }
  /** Same words in the same order: no content lost, duplicated or reordered. */
  const words = (t: string): string => t.replace(/\s+/g, ' ').trim();

  /** Feeds the text in every chunk size from 1 to 7 and in one piece; all must agree. */
  function allChunkings(text: string): string[] {
    const whole = run([text]);
    expect(words(whole.join(''))).toBe(words(text));
    for (const unit of whole) {
      expect(unit.length).toBeLessThanOrEqual(maxUnitChars);
      expect(unit.trim()).not.toBe('');
      expect(unit).not.toMatch(/^\s*\n/);
    }
    for (let size = 1; size <= 7; size++) {
      const chunks = text.match(new RegExp(`[\\s\\S]{1,${String(size)}}`, 'g')) ?? [];
      expect(run(chunks)).toEqual(whole);
    }
    return whole;
  }

  it('releases at blank lines, keeping separators so the units rebuild the answer', () => {
    const s = createParagraphSplitter();
    expect(s.push('One para')).toEqual([]);
    expect(s.push('graph.\n\nTwo')).toEqual(['One paragraph.\n\n']);
    expect(s.flush()).toEqual(['Two']);
    expect(allChunkings('A.\n\nB line one\nB line two\n\n\nC.')).toEqual([
      'A.\n\n',
      'B line one\nB line two\n\n',
      'C.',
    ]);
  });

  it('cuts a long paragraph at a sentence end after the soft limit', () => {
    const text = 'This sentence is about fifty characters in length. '.repeat(15).trim();
    const out = allChunkings(text);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]?.length).toBeGreaterThanOrEqual(500);
    expect(out[0]?.trimEnd().endsWith('.')).toBe(true);
  });

  it('hard-cuts prose with no sentence end at whitespace before the limit', () => {
    const text = 'word '.repeat(1000);
    expect(allChunkings(text).map((u) => u.length)).toEqual([2000, 2000, 1000]);
    expect(run(['x'.repeat(4500)]).map((u) => u.length)).toEqual([2000, 2000, 500]);
  });

  it('holds a fenced code block whole, including blank lines inside it', () => {
    const text = 'Intro:\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.';
    expect(allChunkings(text)).toEqual([
      'Intro:\n',
      '```ts\nconst a = 1;\n\nconst b = 2;\n```\n',
      'After.',
    ]);
  });

  it('supports tilde fences and needs a matching fence to close', () => {
    const text = '~~~~\nhas ``` inside\n~~~\nstill code\n~~~~\nProse.';
    expect(allChunkings(text)).toEqual(['~~~~\nhas ``` inside\n~~~\nstill code\n~~~~\n', 'Prose.']);
  });

  it('splits a long code block into line-aligned chunks and keeps tracking the fence', () => {
    const line = 'x'.repeat(99);
    const code = '```\n' + Array.from({ length: 50 }, () => line).join('\n') + '\n```\n';
    const text = code + '\nDone.\n\n```js\nlet a;\n```\n\nThird.';
    const out = allChunkings(text);
    expect(out.slice(-3)).toEqual(['Done.\n\n', '```js\nlet a;\n```\n', 'Third.']);
  });

  it('closes a fence that arrives right after a chunk was released (regression)', () => {
    const text =
      '```\n' +
      'x'.repeat(1994) +
      '\n```\n\nProse after code.\n\nSecond para.\n\n```js\nlet a;\n```\n\nThird.\n\n';
    const out = allChunkings(text);
    expect(out.slice(-4)).toEqual([
      'Prose after code.\n\n',
      'Second para.\n\n',
      '```js\nlet a;\n```\n',
      'Third.\n\n',
    ]);
  });

  it('hard-cuts a single overlong code line at the limit', () => {
    const text = '```\n' + 'y'.repeat(2500) + '\n```\n';
    expect(allChunkings(text).map((u) => u.length)).toEqual([4, 2000, 505]);
  });

  it('does not open a fence in the middle of a long line that was cut', () => {
    const text = 'word '.repeat(399) + 'word ```x more text\n\nNext paragraph.';
    const out = allChunkings(text);
    expect(out.at(-1)).toBe('Next paragraph.');
  });

  it('applies the sentence cut when a long paragraph arrives in one chunk', () => {
    const text = 'This sentence is about fifty characters in length. '.repeat(30) + '\n\nEnd.';
    const out = run([text]);
    expect(out.length).toBeGreaterThan(2);
    for (const unit of out.slice(0, -1)) expect(unit.length).toBeLessThan(600);
  });

  it('releases an unclosed code block at the end of the stream', () => {
    expect(run(['```\ncode without end'])).toEqual(['```\ncode without end']);
  });

  it('drops whitespace-only runs and ignores empty pushes', () => {
    expect(run(['', '\n\n', '  \n\n', 'Text'])).toEqual(['Text']);
    expect(run([' '.repeat(5000)])).toEqual([]);
  });

  it('treats a backtick run with backticks after it as prose, not a fence', () => {
    expect(run(['```inline``` code\n\nNext.'])).toEqual(['```inline``` code\n\n', 'Next.']);
  });

  it('keeps its invariants over many generated answers and chunkings', () => {
    let seed = 42;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const pieces = [
      () => 'Short sentence. ',
      () => 'word '.repeat(rand(600)),
      () => '\n\n',
      () => '\n',
      () => '```py\n' + 'print(1)\n'.repeat(rand(400)) + '```\n',
      () => '~~~\n' + 'z'.repeat(rand(3000)) + '\n~~~\n',
      () => 'A long run of prose without any sentence end '.repeat(rand(80)),
    ];
    for (let i = 0; i < 60; i++) {
      let text = '';
      const n = 1 + rand(12);
      for (let j = 0; j < n; j++) text += (pieces[rand(pieces.length)] ?? (() => ''))();
      const chunks: string[] = [];
      for (let k = 0; k < text.length;) {
        const size = 1 + rand(40);
        chunks.push(text.slice(k, k + size));
        k += size;
      }
      const out = run(chunks);
      expect(words(out.join(''))).toBe(words(text));
      for (const unit of out) {
        expect(unit.length).toBeLessThanOrEqual(maxUnitChars);
        expect(unit.trim()).not.toBe('');
      }
    }
  });
});
