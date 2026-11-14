import { personaVersion } from '@local-ai/agent';
import type {
  ChatProvider,
  EmbeddingProvider,
  ModerationProvider,
  ModerationVerdict,
} from '@local-ai/core';
import {
  createOllamaChatProvider,
  createOllamaEmbeddingProvider,
  createOllamaModerationProvider,
} from '@local-ai/providers';
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

export async function digestOf(config: LiveConfig, model: string): Promise<string> {
  const res = await config.fetch(new URL('/api/tags', config.baseUrl).toString(), {
    method: 'GET',
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Ollama /api/tags answered ${String(res.status)}`);
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
        // A turn may call the model more than once (a forced search query, or a
        // tool step before the answer). The answer is the text of the last call
        // that wrote any, which replay then plays back for every call. On a
        // time-sensitive case replay would therefore send the answer's first
        // line as the search query; the eval's search is offline, so it only
        // matters if a case ever checks the query.
        let text = '';
        for await (const chunk of chat.chat(req, signal)) {
          if (chunk.type === 'text') {
            text += chunk.text;
            captured.answer = text;
          }
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

/**
 * Recording timeouts are longer than the API's: another Ollama client on the
 * same machine makes models reload, and a timeout would record a guard outage
 * or a cut-off answer instead of what the models actually say.
 */
const liveTimeouts = { guardMs: 90_000, turnMs: 600_000 };
/** A turn that hit a timeout or a guard outage is run again, up to this many times. */
const maxAttempts = 3;

/**
 * Runs every case against Ollama (ADR-0012) and returns the scores and new
 * fixtures. Labels from earlier fixtures carry over by paragraph text, and
 * synthetic entries are kept as they are; new paragraphs start unlabelled
 * (`harmful: null`), are listed, and fail the tests until I label them.
 */
export async function runLive(
  cases: readonly RedTeamCase[],
  config: LiveConfig,
  previous: Fixtures | undefined,
  onCase: (c: RedTeamCase, index: number) => void = () => undefined,
  onRetry: (c: RedTeamCase, attempt: number) => void = () => undefined,
): Promise<{
  scores: CaseScore[];
  fixtures: Fixtures;
  newParagraphs: string[];
  /** Cases that still ended in a guard outage or an error after every retry. */
  outages: string[];
  retried: string[];
}> {
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
  // Read before the run, so a model pulled mid-run cannot be tagged wrongly.
  const chatDigest = await digestOf(config, config.chatModel);
  const guardDigest = await digestOf(config, config.guardModel);
  const labels = new Map<string, boolean | null>();
  for (const rc of Object.values(previous?.cases ?? {})) {
    for (const u of rc.units) labels.set(u.text, u.harmful);
  }

  const scores: CaseScore[] = [];
  const recordedCases: Record<string, RecordedCase> = {};
  const newParagraphs: string[] = [];
  const outages: string[] = [];
  const retried: string[] = [];
  for (const [index, c] of cases.entries()) {
    onCase(c, index);
    const kept = previous?.cases[c.id];
    if (kept?.synthetic === true) {
      recordedCases[c.id] = kept;
      continue;
    }
    let rec = recording(chat, moderation);
    let outcome = await runTurn(rec, c.input, liveTimeouts);
    for (
      let attempt = 1;
      attempt < maxAttempts && (outcome.error !== undefined || outcome.refusal === 'unavailable');
      attempt++
    ) {
      // Logged, so a flaky guard or an intermittent bug stays visible.
      onRetry(c, attempt + 1);
      retried.push(c.id);
      rec = recording(chat, moderation);
      outcome = await runTurn(rec, c.input, liveTimeouts);
    }
    const units = [...rec.captured.units].map(([text, verdict]) => {
      const harmful = labels.get(text);
      if (harmful === undefined || harmful === null) {
        newParagraphs.push(`${c.id}: ${text.slice(0, 120)}`);
      }
      return { text, verdict, harmful: harmful ?? null };
    });
    const recorded: RecordedCase = {
      ...(rec.captured.input === undefined ? {} : { input: rec.captured.input }),
      ...(outcome.chatCalled ? { answer: rec.captured.answer } : {}),
      units,
      ...(outcome.chatCalled && outcome.refusal !== undefined ? { truncated: true } : {}),
    };
    recordedCases[c.id] = recorded;
    scores.push(scoreCase(c, outcome, recorded));
    if (outcome.error !== undefined || outcome.refusal === 'unavailable') outages.push(c.id);
  }

  const fixtures: Fixtures = {
    recordedAt: config.now().toISOString().slice(0, 10),
    chatModel: config.chatModel,
    chatDigest,
    guardModel: config.guardModel,
    guardDigest,
    personaVersion,
    cases: recordedCases,
  };
  return { scores, fixtures, newParagraphs, outages, retried };
}

/** The live chat provider, for other live runs such as the routing eval. */
export function createLiveChat(config: LiveConfig): ChatProvider {
  return createOllamaChatProvider({
    baseUrl: config.baseUrl,
    model: config.chatModel,
    keepAlive: '30m',
    fetch: config.fetch,
  });
}

/** The live embedding provider, for the memory recall eval. */
export function createLiveEmbeddings(config: LiveConfig, model: string): EmbeddingProvider {
  return createOllamaEmbeddingProvider({
    baseUrl: config.baseUrl,
    model,
    keepAlive: '30m',
    fetch: config.fetch,
  });
}
