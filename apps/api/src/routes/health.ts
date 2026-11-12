import type { FastifyInstance } from 'fastify';

import type { AppDeps } from '../deps.js';

export function registerHealthRoutes(app: FastifyInstance, deps: AppDeps): void {
  /** Liveness: the process is up. */
  app.get('/healthz', () => ({ status: 'ok' }));

  /** Readiness: the guard model has answered, so turns will not fail closed on a cold start. */
  app.get('/readyz', (_request, reply) =>
    deps.isReady() ? reply.send({ status: 'ready' }) : reply.code(503).send({ status: 'starting' }),
  );
}
