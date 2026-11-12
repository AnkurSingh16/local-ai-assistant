import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import type { Config } from './config.js';
import { ConfigError, loadConfig } from './config.js';

/**
 * Pre-flight checks for `npm run dev` (ADR-0010). Each check says what is
 * wrong and the exact command that fixes it. SearXNG joins in Milestone 4.
 */

export const minOllamaVersion = '0.40.15';

/** Digests from `ollama list` on 2026-11-12, as recorded in ADR-0010. */
export const pinnedDigests: Readonly<Record<string, string>> = {
  'qwen2.5:7b': '845dbda0ea48',
  'llama-guard3:1b': '494147e06bf9',
  'llama-guard3:8b': '46f211c3d866',
};

export interface CheckResult {
  readonly ok: boolean;
  readonly name: string;
  readonly detail: string;
  readonly fix?: string;
}

export type DoctorFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/**
 * Compares dotted versions numerically (0.40.15 is newer than 0.9.0). A
 * pre-release such as 0.40.15-rc1 comes before its release, so it does not
 * meet that minimum.
 */
export function versionAtLeast(actual: string, minimum: string): boolean {
  const [core = '', pre] = actual.split('-', 2);
  const a = core.split('.').map((p) => Number.parseInt(p, 10));
  const b = minimum.split('.').map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x)) return false;
    if (x !== y) return x > y;
  }
  return pre === undefined;
}

const versionSchema = z.object({ version: z.string() });
const tagsSchema = z.object({
  models: z.array(z.object({ name: z.string(), digest: z.string() })),
});

async function getJson(fetchFn: DoctorFetch, url: string): Promise<unknown> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json();
}

export async function checkOllama(config: Config, fetchFn: DoctorFetch): Promise<CheckResult[]> {
  const base = config.ollamaBaseUrl;
  let version: unknown;
  try {
    version = await getJson(fetchFn, new URL('/api/version', base).toString());
  } catch {
    return [
      {
        ok: false,
        name: 'Ollama',
        detail: `not reachable at ${base}`,
        fix: 'Start the Ollama app, or run: ollama serve',
      },
    ];
  }
  const results: CheckResult[] = [];
  const v = versionSchema.safeParse(version).data?.version ?? 'unknown';
  results.push(
    versionAtLeast(v, minOllamaVersion)
      ? { ok: true, name: 'Ollama', detail: `version ${v}` }
      : {
          ok: false,
          name: 'Ollama',
          detail: `version ${v} is older than ${minOllamaVersion}`,
          fix: 'Update Ollama from https://ollama.com/download',
        },
  );

  let tags: unknown;
  try {
    tags = await getJson(fetchFn, new URL('/api/tags', base).toString());
  } catch {
    results.push({
      ok: false,
      name: 'Models',
      detail: 'could not list models',
      fix: 'ollama list',
    });
    return results;
  }
  const models = new Map(
    (tagsSchema.safeParse(tags).data?.models ?? []).map((m) => [m.name, m.digest] as const),
  );
  for (const model of [config.chatModel, config.guardModel]) {
    const digest = models.get(model);
    const pinned = pinnedDigests[model];
    if (digest === undefined) {
      results.push({ ok: false, name: model, detail: 'not pulled', fix: `ollama pull ${model}` });
    } else if (pinned !== undefined && !digest.startsWith(pinned)) {
      results.push({
        ok: false,
        name: model,
        detail: `digest ${digest.slice(0, 12)} differs from the pinned ${pinned}`,
        fix: `Re-pull with: ollama pull ${model}, or record the new digest in a new ADR`,
      });
    } else {
      results.push({ ok: true, name: model, detail: `digest ${digest.slice(0, 12)}` });
    }
  }
  return results;
}

export function checkPortFree(host: string, port: number, name: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve({
        ok: false,
        name,
        detail: `port ${String(port)} is already in use`,
        fix: `Stop whatever is listening (lsof -nP -iTCP:${String(port)} -sTCP:LISTEN), or choose another port`,
      });
    });
    server.listen(port, host, () => {
      server.close(() => {
        resolve({ ok: true, name, detail: `port ${String(port)} is free` });
      });
    });
  });
}

export function format(results: readonly CheckResult[]): string {
  return results
    .map(
      (r) =>
        `${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}: ${r.detail}${r.fix === undefined ? '' : `\n      fix: ${r.fix}`}`,
    )
    .join('\n');
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\nSee docs/reference/configuration.md\n`);
      process.exit(1);
    }
    throw err;
  }
  const results: CheckResult[] = [
    { ok: true, name: 'Node', detail: process.version },
    await checkPortFree(config.host, config.port, 'API'),
    await checkPortFree('127.0.0.1', 5173, 'Web'),
  ];
  if (config.providers === 'ollama') {
    results.push(...(await checkOllama(config, (url, init) => fetch(url, init))));
  } else {
    results.push({ ok: true, name: 'Providers', detail: 'mock providers; Ollama not needed' });
  }
  process.stdout.write(`${format(results)}\n`);
  if (results.some((r) => !r.ok)) process.exit(1);
}

// Runs only when executed directly, so tests can import the checks.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) void main();
