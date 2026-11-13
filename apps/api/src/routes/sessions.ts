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

  const sessionOf = async (
    cookies: Readonly<Record<string, string | undefined>>,
    authorization: string | undefined,
  ): Promise<string | undefined> => {
    const token = tokenFrom(cookies, authorization);
    return token === undefined ? undefined : sessions.resolve(token);
  };

  // ADR-0009: everything remembered is visible, and deleting is real.
  app.get('/v1/me/memory', async (request, reply) => {
    const sessionId = await sessionOf(request.cookies, request.headers.authorization);
    if (sessionId === undefined) {
      return apiError(reply, request, 401, 'no_session', 'There is no active session.');
    }
    const items = await sessions.memory(sessionId);
    return reply.send({
      items: items.map((m) => ({
        id: m.id,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  });

  app.delete<{ Params: { id: string } }>('/v1/me/memory/:id', async (request, reply) => {
    const sessionId = await sessionOf(request.cookies, request.headers.authorization);
    if (sessionId === undefined) {
      return apiError(reply, request, 401, 'no_session', 'There is no active session.');
    }
    if (!(await sessions.forget(sessionId, request.params.id.slice(0, 100)))) {
      return apiError(reply, request, 404, 'not_found', 'That item does not exist.');
    }
    return reply.code(204).send();
  });

  app.delete('/v1/me', async (request, reply) => {
    const sessionId = await sessionOf(request.cookies, request.headers.authorization);
    if (sessionId === undefined) {
      return apiError(reply, request, 401, 'no_session', 'There is no active session.');
    }
    await sessions.deleteEverything(sessionId);
    void reply.clearCookie(sessionCookie, { path: '/' });
    return reply.code(204).send();
  });
}
