export type { AppDeps } from './deps.js';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Fastify, { LogController } from 'fastify';

import type { AppDeps } from './deps.js';
import { apiError } from './http.js';
import { createClockStore, createTurnSlots } from './limits.js';
import { registerChatRoute } from './routes/chat.js';
import { registerHealthRoutes } from './routes/health.js';

/** Fastify's own limit, before any parsing (ADR-0005). */
export const bodyLimitBytes = 16 * 1024;

export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  // Widened to Fastify's logger type so the instance matches the route modules' signatures.
  const logger: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance: logger,
    // Request logs come from logEvent; Fastify's own would include URLs and headers.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: bodyLimitBytes,
    genReqId: () => deps.newId(),
    trustProxy: false,
  });

  if (deps.onRoute !== undefined) {
    const observe = deps.onRoute;
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) observe({ method, url: route.url });
    });
  }

  // Only JSON bodies: a cross-site HTML form can send text/plain without a
  // preflight, so removing that parser turns such posts into 415s (ADR-0007).
  app.removeContentTypeParser(['text/plain']);

  const allowedHosts = new Set(config.allowedHosts.map((h) => h.toLowerCase()));
  const allowedOrigins = new Set(config.allowedOrigins);

  // DNS rebinding defence: a rebinding page reaches the API under the attacker's
  // hostname, so anything but an allowed Host header is refused first (ADR-0007).
  app.addHook('onRequest', async (request, reply) => {
    const host = (request.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) {
      deps.logEvent({
        event: 'request_rejected',
        requestId: request.id,
        route: request.routeOptions.url ?? 'unknown',
        status: 403,
        reason: 'host',
      });
      return apiError(reply, request, 403, 'forbidden', 'This host is not allowed.');
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      deps.logEvent({
        event: 'request_rejected',
        requestId: request.id,
        route: request.routeOptions.url ?? 'unknown',
        status: 403,
        reason: 'origin',
      });
      return apiError(reply, request, 403, 'forbidden', 'This origin is not allowed.');
    }
    return undefined;
  });

  await app.register(cors, {
    origin: [...allowedOrigins],
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type'],
    credentials: true,
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: false,
    store: createClockStore(deps.clock),
    errorResponseBuilder: (request, context) => {
      deps.logEvent({
        event: 'request_rejected',
        requestId: request.id,
        route: request.routeOptions.url ?? 'unknown',
        status: 429,
        reason: 'rate_limited',
      });
      return {
        statusCode: 429,
        error: {
          code: 'rate_limited',
          message: 'Too many requests. Please wait a moment and try again.',
          requestId: request.id,
          retryAfterMs: context.ttl,
        },
      };
    },
  });

  app.setNotFoundHandler((request, reply) =>
    apiError(reply, request, 404, 'not_found', 'Not found.'),
  );
  app.setErrorHandler((err: { statusCode?: number }, request, reply) => {
    // Fastify's own errors (body too large, bad JSON, wrong content type) keep
    // their status; nothing from the error itself reaches the client.
    const status = err.statusCode !== undefined && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 429) return reply.code(429).send(err);
    const code =
      status === 413
        ? 'too_large'
        : status === 415
          ? 'unsupported_media_type'
          : status < 500
            ? 'bad_request'
            : 'internal';
    if (status >= 500) request.log.error({ requestId: request.id }, 'unhandled error');
    return apiError(
      reply,
      request,
      status,
      code,
      status < 500 ? 'The request was not accepted.' : 'Something went wrong.',
    );
  });

  registerHealthRoutes(app, deps);
  registerChatRoute(app, deps, createTurnSlots(config.maxConcurrentTurns, config.maxQueuedTurns));
  return app;
}
