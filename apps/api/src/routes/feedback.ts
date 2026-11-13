import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppDeps } from '../deps.js';
import { apiError } from '../http.js';
import { tokenFrom } from '../sessions.js';

const bodySchema = z.strictObject({
  kind: z.enum(['feedback', 'correction', 'preference']),
  text: z.string().trim().min(1).max(1000),
});

/**
 * POST /v1/feedback queues feedback, a correction or a preference for review.
 * The answer is the same whether the item was queued or dropped by moderation,
 * so the endpoint cannot be used to probe the guards.
 */
export function registerFeedbackRoute(app: FastifyInstance, deps: AppDeps): void {
  const sessions = deps.sessions;
  const feedback = deps.feedback;
  if (sessions === undefined || feedback === undefined) return;
  app.post(
    '/v1/feedback',
    { config: { rateLimit: { max: 20, timeWindow: deps.config.rateLimitWindowMs } } },
    async (request, reply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return apiError(reply, request, 400, 'bad_request', 'The request body is not valid.');
      }
      const token = tokenFrom(request.cookies, request.headers.authorization);
      const sessionId = token === undefined ? undefined : await sessions.resolve(token);
      if (sessionId === undefined) {
        return apiError(reply, request, 401, 'no_session', 'There is no active session.');
      }
      try {
        await feedback.submit(
          sessionId,
          parsed.data.kind,
          parsed.data.text,
          AbortSignal.timeout(deps.config.guardTimeoutMs + 1_000),
        );
      } catch {
        return apiError(
          reply,
          request,
          503,
          'unavailable',
          'Feedback could not be checked right now.',
        );
      }
      return reply.code(202).send({ received: true });
    },
  );
}
