import { personaVersion } from '@local-ai/agent';
import type { ChatProvider, ModerationProvider, ModerationVerdict } from '@local-ai/core';
import { createOllamaChatProvider, createOllamaModerationProvider } from '@local-ai/providers';
import { z } from 'zod';

import { runTurn } from './pipeline.js';
import type { Fixtures, RecordedCase, RedTeamCase } from './schema.js';
import type { CaseScore } from './score.js';
import { scoreCase } from './score.js';

export interface LiveConfig {
  readonly baseUrl: string;
  readonly chatModel: string;
  readonly guardModel: string;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Wall-clock time for the fixture header; injected so this module never reads the clock. */
  readonly now: () => Date;
}

const tagsSchema = z.object({
  models: z.array(z.object({ name: z.string(), digest: z.string() })),
});

async function digestOf(config: LiveConfig, model: string): Promise<string> {
  const res = await config.fetch(new URL('/api/tags', config.baseUrl).toString(), {
    method: 'GET',
    signal: AbortSignal.timeout(5_000),
  });
  const tags = tagsSchema.parse(await res.json());
  const found = tags.models.find((m) => m.name === model || m.name === `${model}:latest`);
  if (found === undefined) throw new Error(`${model} is not pulled`);
  return found.digest.slice(0, 12);
}

/** Wraps the real providers so every guard verdict and the full answer are captured. */
function recording(chat: ChatProvider, moderation: ModerationProvider) {
  const captured: {
    input?: ModerationVerdict;
    answer: string;
    units: Map<string, ModerationVerdict>;
  } = { answer: '', units: new Map() };
  return {
    captured,
    chat: {
      async *chat(req, signal) {
        for await (const chunk of chat.chat(req, signal)) {
          if (chunk.type === 'text') captured.answer += chunk.text;
          yield chunk;
        }
      },
    } satisfies ChatProvider,
    moderation: {
      async classify(input, signal) {
        const verdict = await moderation.classify(input, signal);
        if (input.role === 'user') captured.input = verdict;
        else captured.units.set(input.text, verdict);
        return verdict;
      },
      ...(moderation.isResident === undefined
        ? {}
        : { isResident: moderation.isResident.bind(moderation) }),
    } satisfies ModerationProvider,
  };
}

/** Real-model timeouts: the guard may need a load, and answers can run long. */
const liveTimeouts = { guardMs: 20_000, turnMs: 180_000 };

/**
 * Runs every case against Ollama (ADR-0012) and returns the scores and new
 * fixtures. Labels from earlier fixtures carry over by paragraph text, and
 * synthetic entries are kept as they are; new paragraphs start unlabelled
 * (`harmful: false`) and are listed so I can label them.
 */
export async function runLive(
  cases: readonly RedTeamCase[],
  config: LiveConfig,
  previous: Fixtures | undefined,
  onCase: (c: RedTeamCase, index: number) => void = () => undefined,
): Promise<{ scores: CaseScore[]; fixtures: Fixtures; newParagraphs: string[] }> {
  const fetchFn = config.fetch;
  const chat = createOllamaChatProvider({
    baseUrl: config.baseUrl,
    model: config.chatModel,
    keepAlive: '30m',
    fetch: fetchFn,
  });
  const moderation = createOllamaModerationProvider({
    baseUrl: config.baseUrl,
    model: config.guardModel,
    keepAlive: '30m',
    fetch: fetchFn,
  });
  const labels = new Map<string, boolean>();
  for (const rc of Object.values(previous?.cases ?? {})) {
    for (const u of rc.units) labels.set(u.text, u.harmful);
  }

  const scores: CaseScore[] = [];
  const recordedCases: Record<string, RecordedCase> = {};
  const newParagraphs: string[] = [];
  for (const [index, c] of cases.entries()) {
    onCase(c, index);
    const kept = previous?.cases[c.id];
    if (kept?.synthetic === true) {
      recordedCases[c.id] = kept;
      continue;
    }
    const rec = recording(chat, moderation);
    const outcome = await runTurn(rec, c.input, liveTimeouts);
    const units = [...rec.captured.units].map(([text, verdict]) => {
      const harmful = labels.get(text);
      if (harmful === undefined) newParagraphs.push(`${c.id}: ${text.slice(0, 120)}`);
      return { text, verdict, harmful: harmful ?? false };
    });
    const recorded: RecordedCase = {
      ...(rec.captured.input === undefined ? {} : { input: rec.captured.input }),
      ...(outcome.chatCalled ? { answer: rec.captured.answer } : {}),
      units,
    };
    recordedCases[c.id] = recorded;
    scores.push(scoreCase(c, outcome, recorded));
  }

  const fixtures: Fixtures = {
    recordedAt: config.now().toISOString().slice(0, 10),
    chatModel: config.chatModel,
    chatDigest: await digestOf(config, config.chatModel),
    guardModel: config.guardModel,
    guardDigest: await digestOf(config, config.guardModel),
    personaVersion,
    cases: recordedCases,
  };
  return { scores, fixtures, newParagraphs };
}
