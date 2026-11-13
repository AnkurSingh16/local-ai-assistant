import { Worker } from 'node:worker_threads';

import { z } from 'zod';

import type { FetchedPage } from './safe-fetch.js';

export interface ParsedPage {
  readonly title: string;
  readonly text: string;
}

export type ParseError = 'parse_failed' | 'parse_timeout';

export class ParseFailure extends Error {
  constructor(readonly reason: ParseError) {
    super(`page parse failed: ${reason}`);
    this.name = 'ParseFailure';
  }
}

export type ParsePage = (page: FetchedPage, signal: AbortSignal) => Promise<ParsedPage>;

export interface ParseConfig {
  /** ADR-0008: 2 s per parse, counted from when the worker has loaded jsdom. */
  readonly timeoutMs?: number;
  /** Upper bound on starting a worker and loading jsdom. */
  readonly startupTimeoutMs?: number;
  /** ADR-0008: at most 2 parses at once. */
  readonly maxConcurrent?: number;
  /** About 1,000 tokens of prose at four characters per token (ADR-0004). */
  readonly maxChars?: number;
}

const readySchema = z.object({ ready: z.literal(true) });
const squash = (text: string): string =>
  text
    .replace(/[ \t\f\v\u00A0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const resultSchema = z.union([
  z.object({ ok: z.literal(true), title: z.string(), text: z.string() }),
  z.object({ ok: z.literal(false) }),
]);

// From source the worker is a .ts file that Node loads with type stripping; built, it is .js.
const workerUrl = new URL(
  import.meta.url.endsWith('.ts') ? './parse-worker.ts' : './parse-worker.js',
  import.meta.url,
);

/** Waiting reads are capped too, so a burst cannot pile up page bodies in memory. */
const maxWaiting = 8;

/**
 * A counting semaphore, so a burst of reads cannot start more than `limit`
 * workers. A waiter whose signal aborts leaves the queue at once.
 */
function createLimiter(
  limit: number,
): <T>(task: () => Promise<T>, signal: AbortSignal) => Promise<T> {
  let active = 0;
  const waiting: { start: () => void }[] = [];
  return async (task, signal) => {
    if (active >= limit) {
      if (waiting.length >= maxWaiting) throw new ParseFailure('parse_failed');
      await new Promise<void>((resolve, reject) => {
        const entry = {
          start: () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          },
        };
        const onAbort = (): void => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiting.push(entry);
      });
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.start();
    }
  };
}

/**
 * Parses a fetched page with jsdom and Readability in a worker thread with a
 * 256 MB heap, terminated after the timeout or when the caller aborts.
 */
export function createPageParser(config: ParseConfig = {}): ParsePage {
  const timeoutMs = config.timeoutMs ?? 2_000;
  // Measured at 250 to 620 ms on my Mac; read_page's 10 s deadline bounds the whole read anyway.
  const startupTimeoutMs = config.startupTimeoutMs ?? 3_000;
  const maxChars = config.maxChars ?? 4_000;
  const limit = createLimiter(config.maxConcurrent ?? 2);

  return (page, signal) => {
    // Plain text needs no DOM, so it skips the worker.
    if (page.contentType === 'text/plain') {
      return Promise.resolve({ title: '', text: squash(page.body).slice(0, maxChars) });
    }
    return limit(
      () =>
        new Promise<ParsedPage>((resolve, reject) => {
          signal.throwIfAborted();
          const worker = new Worker(workerUrl, {
            workerData: { body: page.body, url: page.url, contentType: page.contentType, maxChars },
            resourceLimits: { maxOldGenerationSizeMb: 256 },
          });
          let settled = false;
          // The slot is freed only once the worker has exited, so no more than
          // `maxConcurrent` workers are ever alive.
          const finish = (outcome: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            void worker.terminate().finally(outcome);
          };
          const onAbort = (): void => {
            finish(() => {
              reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            });
          };
          const timeOut = (): void => {
            finish(() => {
              reject(new ParseFailure('parse_timeout'));
            });
          };
          let timer = setTimeout(timeOut, startupTimeoutMs);
          signal.addEventListener('abort', onAbort, { once: true });
          worker.on('message', (message: unknown) => {
            if (readySchema.safeParse(message).success) {
              clearTimeout(timer);
              timer = setTimeout(timeOut, timeoutMs);
              return;
            }
            const parsed = resultSchema.safeParse(message);
            finish(() => {
              if (parsed.success && parsed.data.ok) {
                resolve({ title: parsed.data.title, text: parsed.data.text });
              } else {
                reject(new ParseFailure('parse_failed'));
              }
            });
          });
          worker.once('error', () => {
            finish(() => {
              reject(new ParseFailure('parse_failed'));
            });
          });
          worker.once('exit', () => {
            finish(() => {
              reject(new ParseFailure('parse_failed'));
            });
          });
        }),
      signal,
    );
  };
}
