import type { FastifyInstance } from 'fastify';

import type { AppDeps } from '../deps.js';
import { apiError } from '../http.js';
import { sessionCookie, tokenFrom } from '../sessions.js';

/** ADR-0009: 30 days idle, matching the session lifetime in storage. */
const cookieMaxAgeSeconds = 30 * 24 * 60 * 60;

/**
 * POST /v1/sessions creates an anonymous session. The web app gets it as an
 * HttpOnly, SameSite=Strict cookie; the mobile app reads the token from the
 * body and sends it as a bearer token.
 */
export function registerSessionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const sessions = deps.sessions;
  if (sessions === undefined) return;
  app.post(
    '/v1/sessions',
    // Per IP, so per-session limits cannot be dodged by minting sessions (ADR-0009).
    { config: { rateLimit: { max: 10, timeWindow: 60 * 60 * 1000 } } },
    async (request, reply) => {
      try {
        const token = await sessions.create();
        const loopback = ['127.0.0.1', 'localhost', '::1'].includes(deps.config.host);
        void reply.setCookie(sessionCookie, token, {
          httpOnly: true,
          sameSite: 'strict',
          secure: !loopback,
          path: '/',
          maxAge: cookieMaxAgeSeconds,
        });
        return await reply.code(201).send({ token });
      } catch {
        return apiError(reply, request, 500, 'internal', 'Could not start a session.');
      }
    },
  );

  // Lets a client that cannot read its HttpOnly cookie learn whether it still has a session.
  app.get('/v1/me', async (request, reply) => {
    const token = tokenFrom(request.cookies, request.headers.authorization);
    const sessionId = token === undefined ? undefined : await sessions.resolve(token);
    if (sessionId === undefined) {
      return apiError(reply, request, 401, 'no_session', 'There is no active session.');
    }
    return reply.send({ active: true });
  });
}
