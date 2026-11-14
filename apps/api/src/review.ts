import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { systemClock } from '@local-ai/core';
import { createInputGuard } from '@local-ai/guardrails';
import { createOllamaEmbeddingProvider, createOllamaModerationProvider } from '@local-ai/providers';
import { createMemoryRepo, createReviewRepo, openDatabase } from '@local-ai/storage';
import { z } from 'zod';

import { loadConfig } from './config.js';
import {
  approvalMessage,
  createReviewer,
  paraphraseProblem,
  parseApproveArgs,
} from './learning.js';

/**
 * `npm run review`: my review queue (ADR-0009). Only items I approve become
 * memory; a promoted eval case is a paraphrase I type, never the user's words.
 *
 *   npm run review                       list pending items
 *   npm run review -- approve <id>       approve (preferences and corrections become memory)
 *   npm run review -- approve <id> --always   approve as memory used in every prompt (allergies, health)
 *   npm run review -- reject <id>
 *   npm run review -- promote <id> <category> <expect> "<paraphrase>"
 */
const expectations = ['refuse', 'self_harm_resources', 'answer', 'no_harm', 'crisis_line'] as const;
const casesPath = new URL('../../../packages/eval/cases/redteam.json', import.meta.url);
const caseSchema = z.array(z.object({ id: z.string(), category: z.string() }).loose());

async function main(): Promise<void> {
  const config = loadConfig();
  const fetchFn = (input: string, init: RequestInit): Promise<Response> => fetch(input, init);
  const db = openDatabase(config.databasePath);
  const deps = { db, clock: systemClock, newId: () => randomUUID() };
  const review = createReviewRepo(deps);
  const reviewer = createReviewer({
    review,
    memory: createMemoryRepo(deps),
    embeddings: createOllamaEmbeddingProvider({
      baseUrl: config.ollamaBaseUrl,
      model: config.embedModel,
      keepAlive: config.ollamaKeepAlive,
      fetch: fetchFn,
    }),
    inputGuard: createInputGuard({
      moderation: createOllamaModerationProvider({
        baseUrl: config.ollamaBaseUrl,
        model: config.guardModel,
        keepAlive: config.ollamaKeepAlive,
        fetch: fetchFn,
      }),
      timeoutMs: config.guardTimeoutMs,
    }),
  });
  const [command, ...args] = process.argv.slice(2);
  const signal = AbortSignal.timeout(60_000);
  try {
    if (command === undefined || command === 'list') {
      const items = await reviewer.pending();
      if (items.length === 0) process.stdout.write('Nothing waiting for review.\n');
      for (const item of items) {
        process.stdout.write(
          `${item.id}  ${item.kind.padEnd(10)}  ${item.content.replace(/\s+/g, ' ').slice(0, 120)}\n`,
        );
      }
    } else if (command === 'approve') {
      const parsed = parseApproveArgs(args);
      if ('error' in parsed) throw new Error(parsed.error);
      const outcome = await reviewer.approve(parsed.id, signal, { always: parsed.always });
      process.stdout.write(`${approvalMessage(outcome, parsed.always)}\n`);
    } else if (command === 'reject' && args[0] !== undefined) {
      process.stdout.write((await reviewer.reject(args[0])) ? 'rejected\n' : 'not_found\n');
    } else if (command === 'promote' && args.length === 4) {
      const [id = '', category = '', expect = '', paraphrase = ''] = args;
      const item = await review.get(id);
      const expectation = expectations.find((e) => e === expect);
      if (item === undefined) throw new Error('No such review item.');
      if (expectation === undefined)
        throw new Error(`expect must be one of ${expectations.join(', ')}`);
      if (!/^[a-z_]+$/.test(category))
        throw new Error('category must be lowercase words joined by _');
      const problem = paraphraseProblem(item.content, paraphrase);
      if (problem !== undefined) throw new Error(`Refused: the paraphrase ${problem}.`);
      const cases = caseSchema.parse(JSON.parse(readFileSync(casesPath, 'utf8')));
      const n = cases.filter((c) => c.category === category).length + 1;
      const newId = `${category}-${String(n).padStart(3, '0')}`;
      // Only the paraphrase, a category and the expectation: no session, time or source id.
      cases.push({ id: newId, category, input: paraphrase, expect: expectation });
      writeFileSync(casesPath, `${JSON.stringify(cases, null, 2)}\n`);
      process.stdout.write(
        `Added ${newId}. Record it with: npm run eval:record -- --only=${newId}\n`,
      );
    } else {
      process.stdout.write(
        'Usage: npm run review -- [list | approve <id> [--always] | reject <id> | promote <id> <category> <expect> "<paraphrase>"]\n',
      );
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : 'review failed'}\n`);
    process.exit(1);
  });
}
