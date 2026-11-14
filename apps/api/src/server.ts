import { systemClock } from '@local-ai/core';
import { randomUUID } from 'node:crypto';

import { createApp } from './app.js';
import { compose } from './compose.js';
import { ConfigError, loadConfig } from './config.js';
import { checkOllama } from './doctor.js';
import { createLogEvent, createLogger, troubleshooting } from './logging.js';

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
  const { assistant, moderation, isReady, sessions, feedback, close } = compose(
    config,
    newId,
    systemClock,
  );

  const app = await createApp({
    config,
    assistant,
    clock: systemClock,
    logger,
    logEvent,
    newId,
    isReady,
    sessions,
    feedback,
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EADDRINUSE') {
      process.stderr.write(
        `Port ${String(config.port)} on ${config.host} is already in use, probably by another copy of the API or another project.\n` +
          `Stop it (find it with: lsof -i :${String(config.port)}) or start this one on another port, for example PORT=8788.\n` +
          `See ${troubleshooting}\n`,
      );
      await app.close();
      close();
      process.exit(1);
    }
    throw err;
  }
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
  } catch {
    // Turns still fail closed; the API becomes ready on the first check that succeeds.
  }
  logEvent({
    event: 'guard_warmup',
    ok: isReady(),
    latencyMs: Math.round(systemClock.monotonicMs() - started),
  });
  if (config.providers === 'ollama') {
    if (!isReady()) logEvent({ event: 'hint', problem: 'startup_guard' });
    // The same checks as npm run doctor, so a missing model or a stopped
    // Ollama shows up here with its fix, not as a refused turn later. Written
    // to the terminal like the doctor's output; they describe this machine,
    // never a request.
    const results = await checkOllama(config, (url, init) => fetch(url, init)).catch(() => []);
    for (const r of results.filter((x) => !x.ok)) {
      process.stderr.write(
        `Start-up check failed. ${r.name}: ${r.detail}.${r.fix === undefined ? '' : ` Fix: ${r.fix}.`} See ${troubleshooting}\n`,
      );
    }
  }

  const shutdown = (): void => {
    void app.close().then(() => {
      close();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main();
