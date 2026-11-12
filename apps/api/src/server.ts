import { systemClock } from '@local-ai/core';
import { randomUUID } from 'node:crypto';

import { createApp } from './app.js';
import { compose } from './compose.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogEvent, createLogger } from './logging.js';

const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\nSee docs/reference/configuration.md\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel, config.nodeEnv === 'development');
  const logEvent = createLogEvent(logger);
  const newId = (): string => randomUUID();
  const { assistant, moderation } = compose(config, newId);

  let ready = false;
  const app = await createApp({
    config,
    assistant,
    clock: systemClock,
    logger,
    logEvent,
    newId,
    isReady: () => ready,
  });

  await app.listen({ host: config.host, port: config.port });
  logEvent({
    event: 'server_started',
    host: config.host,
    port: config.port,
    providers: config.providers,
  });
  if (!loopbackHosts.has(config.host)) logEvent({ event: 'server_exposed', host: config.host });

  // Load the guard model now, so the first turn does not wait for it (ADR-0005).
  const started = systemClock.monotonicMs();
  try {
    await moderation.classify(
      { role: 'user', text: 'Hello.' },
      AbortSignal.timeout(config.guardTimeoutMs),
    );
    ready = true;
  } catch {
    // Turns still fail closed; readiness stays false until a restart.
  }
  logEvent({
    event: 'guard_warmup',
    ok: ready,
    latencyMs: Math.round(systemClock.monotonicMs() - started),
  });

  const shutdown = (): void => {
    void app.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main();
