import { z } from 'zod';

/**
 * All runtime configuration, from environment variables, validated once at
 * startup (ADR-0010). This is one of the two places allowed to read
 * process.env; everything else receives the parsed config.
 */

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== ''),
);

const positiveInt = z.coerce.number().int().positive();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** `mock` runs the deterministic providers, for end-to-end tests and demos without Ollama. */
  PROVIDERS: z.enum(['ollama', 'mock']).default('ollama'),
  OLLAMA_BASE_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:11434'),
  // Loopback only (ADR-0010): queries derived from user messages never travel in clear text.
  SEARXNG_URL: z
    .url({ protocol: /^https?$/ })
    .refine((u) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname), {
      message: 'SEARXNG_URL must point at loopback (127.0.0.1, localhost or [::1])',
    })
    .default('http://127.0.0.1:8888'),
  SEARCH_TIMEOUT_MS: positiveInt.default(5_000),
  /** One SQLite file (ADR-0001); ":memory:" keeps nothing on disk, for tests and demos. */
  DATABASE_PATH: z.string().min(1).default('data/assistant.db'),
  CHAT_MODEL: z.string().min(1).default('qwen2.5:7b'),
  GUARD_MODEL: z.string().min(1).default('llama-guard3:1b'),
  EMBED_MODEL: z.string().min(1).default('nomic-embed-text'),
  OLLAMA_KEEP_ALIVE: z
    .string()
    .regex(/^\d+[smh]$/)
    .default('30m'),
  GUARD_TIMEOUT_MS: positiveInt.default(20_000),
  GUARD_WARM_TIMEOUT_MS: positiveInt.default(2_000),
  TURN_TIMEOUT_MS: positiveInt.default(60_000),
  /** Host headers accepted, as host:port. Defaults to localhost and 127.0.0.1 on PORT. */
  ALLOWED_HOSTS: csv.optional(),
  /** Browser origins allowed to call the API. Defaults to the Vite dev server. */
  ALLOWED_ORIGINS: csv.default(['http://localhost:5173', 'http://127.0.0.1:5173']),
  RATE_LIMIT_PER_IP: positiveInt.default(60),
  RATE_LIMIT_WINDOW_MS: positiveInt.default(600_000),
  MAX_CONCURRENT_TURNS: positiveInt.default(2),
  MAX_QUEUED_TURNS: z.coerce.number().int().min(0).default(4),
});

export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly providers: 'ollama' | 'mock';
  readonly ollamaBaseUrl: string;
  readonly chatModel: string;
  readonly guardModel: string;
  readonly ollamaKeepAlive: string;
  readonly guardTimeoutMs: number;
  readonly searxngUrl: string;
  readonly databasePath: string;
  readonly embedModel: string;
  readonly searchTimeoutMs: number;
  readonly guardWarmTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly rateLimitPerIp: number;
  readonly rateLimitWindowMs: number;
  readonly maxConcurrentTurns: number;
  readonly maxQueuedTurns: number;
}

export class ConfigError extends Error {
  constructor(readonly variables: readonly string[]) {
    super(`Invalid configuration: ${variables.join(', ')}`);
    this.name = 'ConfigError';
  }
}

/** Parses an environment, naming every invalid variable. It never echoes values, which may be secrets. */
export function parseConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))]);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && e.PROVIDERS === 'mock') {
    throw new ConfigError(['PROVIDERS']);
  }
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    providers: e.PROVIDERS,
    ollamaBaseUrl: e.OLLAMA_BASE_URL,
    chatModel: e.CHAT_MODEL,
    guardModel: e.GUARD_MODEL,
    ollamaKeepAlive: e.OLLAMA_KEEP_ALIVE,
    guardTimeoutMs: e.GUARD_TIMEOUT_MS,
    searxngUrl: e.SEARXNG_URL,
    databasePath: e.DATABASE_PATH,
    embedModel: e.EMBED_MODEL,
    searchTimeoutMs: e.SEARCH_TIMEOUT_MS,
    guardWarmTimeoutMs: e.GUARD_WARM_TIMEOUT_MS,
    turnTimeoutMs: e.TURN_TIMEOUT_MS,
    allowedHosts: e.ALLOWED_HOSTS ?? [`localhost:${String(e.PORT)}`, `127.0.0.1:${String(e.PORT)}`],
    allowedOrigins: e.ALLOWED_ORIGINS,
    rateLimitPerIp: e.RATE_LIMIT_PER_IP,
    rateLimitWindowMs: e.RATE_LIMIT_WINDOW_MS,
    maxConcurrentTurns: e.MAX_CONCURRENT_TURNS,
    maxQueuedTurns: e.MAX_QUEUED_TURNS,
  };
}

export function loadConfig(): Config {
  return parseConfig(process.env);
}
