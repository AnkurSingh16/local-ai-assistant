import type {
  HazardCategory,
  ModerationInput,
  ModerationProvider,
  ModerationVerdict,
} from '@local-ai/core';
import { hazardCategories, ProviderError } from '@local-ai/core';
import { z } from 'zod';

import type { FetchFn } from '../shared/http.js';
import { parseJsonLine, postJson } from '../shared/http.js';
import { readCapped } from '../shared/ndjson.js';

/** A guard verdict or the list of loaded models is small; this bounds what a broken server can make us buffer. */
const maxGuardResponseChars = 64 * 1024;

export interface OllamaModerationConfig {
  readonly baseUrl: string;
  /** llama-guard3:1b below 24 GB of RAM, llama-guard3:8b above (ADR-0006). */
  readonly model: string;
  readonly keepAlive: string;
  readonly fetch: FetchFn;
}

/** Guard calls use a fixed, small context (ADR-0005). */
export const guardNumCtx = 2048;

/**
 * llama-guard3 classifies the last turn of a conversation. For an assistant
 * paragraph it needs a preceding user turn; the real user message is not sent,
 * so the verdict depends on the paragraph alone. The stand-in is an ordinary
 * request: "(user message withheld)" read as something hidden and pushed
 * harmless paragraphs towards unsafe (ADR-0014).
 */
export const standInUserTurn = 'Can you help me with something?';

/**
 * How sure the guard must be before an answer paragraph is withheld. The 1B
 * guard's top answer flagged about 1 harmless paragraph in 10; requiring this
 * probability of "unsafe" kept every harmful one in my test set (ADR-0014).
 * User messages keep the top answer: a flagged message never reaches the model.
 */
export const answerUnsafeThreshold = 0.7;

const logprobSchema = z.object({ token: z.string(), logprob: z.number() });

const responseSchema = z.object({
  message: z.object({ content: z.string() }),
  logprobs: z.array(z.object({ top_logprobs: z.array(logprobSchema).optional() })).optional(),
});

/**
 * The guard's probability of "unsafe" against "safe" at its first token, or
 * undefined when Ollama did not return both, in which case its top answer stands.
 */
export function unsafeProbability(
  logprobs: z.infer<typeof responseSchema>['logprobs'],
): number | undefined {
  const top = logprobs?.[0]?.top_logprobs;
  if (top === undefined) return undefined;
  let unsafe = 0;
  let safe = 0;
  for (const t of top) {
    const word = t.token.trim();
    if (word === 'unsafe') unsafe += Math.exp(t.logprob);
    else if (word === 'safe') safe += Math.exp(t.logprob);
  }
  if (unsafe === 0 || safe === 0) return undefined;
  return unsafe / (unsafe + safe);
}

/** The part of `GET /api/ps` this needs: which models are loaded. */
const psSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      model: z.string().optional(),
      context_length: z.number().int().optional(),
    }),
  ),
});

/** Ollama reports an untagged model as `name:latest`. */
function sameModel(loaded: string, configured: string): boolean {
  return loaded === configured || loaded === `${configured}:latest`;
}

const categorySet: ReadonlySet<string> = new Set(hazardCategories);

function isHazardCategory(value: string): value is HazardCategory {
  return categorySet.has(value);
}

/**
 * Parses "safe" or "unsafe\nS1,S10". Anything else throws, so a confused guard
 * fails closed instead of passing text it did not classify.
 */
export function parseGuardVerdict(content: string): ModerationVerdict {
  const lines = content
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 1 && lines[0] === 'safe') return { flagged: false };
  if (lines[0] === 'unsafe' && lines.length === 2 && lines[1] !== undefined) {
    const codes = lines[1].split(',').map((c) => c.trim());
    const categories = codes.filter(isHazardCategory);
    if (categories.length > 0 && categories.length === codes.length) {
      return { flagged: true, categories };
    }
  }
  throw new ProviderError('bad_response');
}

export function createOllamaModerationProvider(config: OllamaModerationConfig): ModerationProvider {
  const url = new URL('/api/chat', config.baseUrl).toString();
  const psUrl = new URL('/api/ps', config.baseUrl).toString();
  return {
    async isResident(signal: AbortSignal): Promise<boolean> {
      let res: Response;
      try {
        res = await config.fetch(psUrl, { method: 'GET', signal });
      } catch (err) {
        signal.throwIfAborted();
        throw new ProviderError('unavailable', undefined, { cause: err });
      }
      if (!res.ok || res.body === null) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError('unavailable', res.status);
      }
      const parsed = psSchema.safeParse(
        parseJsonLine(await readCapped(res.body, maxGuardResponseChars, signal)),
      );
      if (!parsed.success) throw new ProviderError('bad_response', res.status);
      // Resident means loaded at the context size the guard asks for. Ollama
      // reloads a model asked for at another size (another client may have
      // loaded it at 4096), and that reload takes longer than the short warm
      // deadline, so counting it as warm made every check time out. An Ollama
      // that does not report the size is still matched by name; a wrong "warm"
      // only shortens the deadline, and the guard fails closed on a timeout.
      return parsed.data.models.some(
        (m) =>
          (sameModel(m.name, config.model) || sameModel(m.model ?? '', config.model)) &&
          (m.context_length === undefined || m.context_length === guardNumCtx),
      );
    },

    async classify(input: ModerationInput, signal: AbortSignal): Promise<ModerationVerdict> {
      const messages =
        input.role === 'user'
          ? [{ role: 'user', content: input.text }]
          : [
              { role: 'user', content: standInUserTurn },
              { role: 'assistant', content: input.text },
            ];
      const answer = input.role === 'assistant';
      const res = await postJson(
        config.fetch,
        url,
        {
          model: config.model,
          messages,
          stream: false,
          keep_alive: config.keepAlive,
          options: { num_ctx: guardNumCtx, temperature: 0, num_predict: 20 },
          // The first token's alternatives give the guard's confidence (ADR-0014).
          ...(answer ? { logprobs: true, top_logprobs: 5 } : {}),
        },
        signal,
      );
      if (res.body === null) throw new ProviderError('bad_response', res.status);
      const json = parseJsonLine(await readCapped(res.body, maxGuardResponseChars, signal));
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) throw new ProviderError('bad_response', res.status);
      const verdict = parseGuardVerdict(parsed.data.message.content);
      if (!answer || !verdict.flagged) return verdict;
      const p = unsafeProbability(parsed.data.logprobs);
      return p !== undefined && p < answerUnsafeThreshold ? { flagged: false } : verdict;
    },
  };
}
