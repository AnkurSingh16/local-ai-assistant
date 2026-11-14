import type { SseEvent } from '@local-ai/contract';
import { chatRequestSchema, encodeSseEvent, sseEventId, ssePing } from '@local-ai/contract';
import type { FastifyInstance } from 'fastify';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

import type { AppDeps } from '../deps.js';
import type { LogEvent } from '../logging.js';
import { troubleshooting } from '../logging.js';
import { apiError } from '../http.js';
import type { TurnSlots } from '../limits.js';
import { createWindowLimiter } from '../limits.js';
import { tokenFrom } from '../sessions.js';

const defaultPingIntervalMs = 15_000;

/**
 * POST /v1/chat answers as Server-Sent Events (ADR-0007). The route sees only
 * the assistant's handleTurn, never a provider or a store (ADR-0002).
 */
/** What to do when a turn fails for a reason the operator can fix. */
function hintFor(
  refusalKind: string | undefined,
  errorCode: string | undefined,
  config: AppDeps['config'],
): LogEvent | undefined {
  if (refusalKind === 'unavailable') {
    return {
      event: 'hint',
      problem: 'guard_unavailable',
      hint: `The safety model (${config.guardModel}) did not answer in time, so the turn was refused rather than answered unchecked. Check that Ollama is running (ollama ps), that the model is pulled (ollama pull ${config.guardModel}), and that no other app is keeping Ollama busy, then try again. The first turn after a long idle can be slow while models load. See ${troubleshooting}.`,
    };
  }
  if (errorCode === 'model_unavailable') {
    return {
      event: 'hint',
      problem: 'chat_model_unavailable',
      hint: `The chat model (${config.chatModel}) is not answering. Start Ollama (open the app, or run: ollama serve) and pull the model: ollama pull ${config.chatModel}. See ${troubleshooting}.`,
    };
  }
  if (errorCode === 'timeout') {
    return {
      event: 'hint',
      problem: 'turn_timeout',
      hint: `A turn took longer than TURN_TIMEOUT_MS (${String(config.turnTimeoutMs)} ms). Ollama may be loading a model or busy with another app; try again, or raise TURN_TIMEOUT_MS. See ${troubleshooting}.`,
    };
  }
  return undefined;
}

export function registerChatRoute(app: FastifyInstance, deps: AppDeps, slots: TurnSlots): void {
  // ADR-0011: a limit per session on top of the per-address one, so users behind
  // one address (a proxy, a household) do not share a budget and one session
  // cannot use all of it. Keyed by session id, never by the token.
  const perSession = createWindowLimiter(
    deps.clock,
    deps.config.rateLimitPerSession,
    deps.config.rateLimitWindowMs,
  );
  app.post(
    '/v1/chat',
    {
      config: {
        rateLimit: { max: deps.config.rateLimitPerIp, timeWindow: deps.config.rateLimitWindowMs },
      },
    },
    async (request, reply) => {
      const parsed = chatRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        deps.logEvent({
          event: 'request_rejected',
          requestId: request.id,
          route: '/v1/chat',
          status: 400,
          reason: 'validation',
        });
        return apiError(reply, request, 400, 'bad_request', 'The request body is not valid.');
      }

      // A session makes the turn remembered: history is loaded and the turn stored.
      // Without one the turn is stateless, as before.
      let conversationId = parsed.data.conversationId;
      let remember = false;
      const token = tokenFrom(request.cookies, request.headers.authorization);
      const sessionId =
        token === undefined || deps.sessions === undefined
          ? undefined
          : await deps.sessions.resolve(token);
      if (sessionId !== undefined) {
        const waitMs = perSession.hit(sessionId);
        if (waitMs !== undefined) {
          deps.logEvent({
            event: 'request_rejected',
            requestId: request.id,
            route: '/v1/chat',
            status: 429,
            reason: 'rate_limited',
          });
          return reply
            .code(429)
            .header('retry-after', String(Math.ceil(waitMs / 1000)))
            .send({
              error: {
                code: 'rate_limited',
                message: 'Too many requests. Please wait a moment and try again.',
                requestId: request.id,
                retryAfterMs: waitMs,
              },
            });
        }
      }
      if (sessionId !== undefined && deps.sessions !== undefined) {
        conversationId ??= deps.newId();
        if (!(await deps.sessions.claimConversation(conversationId, sessionId))) {
          return apiError(reply, request, 404, 'not_found', 'That conversation does not exist.');
        }
        remember = true;
      }

      const client = new AbortController();
      const onClose = (): void => {
        client.abort();
      };
      // 'close' fires when the client goes away, and also after a normal end,
      // when aborting is harmless.
      reply.raw.on('close', onClose);

      let release: (() => void) | undefined;
      try {
        release = await slots.acquire(client.signal);
      } catch {
        reply.raw.off('close', onClose);
        return reply;
      }
      if (release === undefined) {
        reply.raw.off('close', onClose);
        deps.logEvent({
          event: 'request_rejected',
          requestId: request.id,
          route: '/v1/chat',
          status: 503,
          reason: 'busy',
        });
        void reply.header('retry-after', '10');
        return apiError(
          reply,
          request,
          503,
          'busy',
          'The assistant is busy. Please try again shortly.',
        );
      }

      const started = deps.clock.monotonicMs();
      const res = reply.raw;
      let ping: ReturnType<typeof setInterval> | undefined;
      let messageId = '';
      let seq = 0;
      let last: SseEvent | undefined;
      let refusalKind: string | undefined;
      let errorCode: string | undefined;
      try {
        reply.hijack();
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-content-type-options': 'nosniff',
          ...corsHeaders(request.headers.origin, deps.config.allowedOrigins),
        });
        ping = setInterval(() => {
          if (!res.writableEnded) res.write(ssePing);
        }, deps.pingIntervalMs ?? defaultPingIntervalMs);

        for await (const event of deps.assistant.handleTurn(
          {
            message: parsed.data.message,
            ...(conversationId === undefined ? {} : { conversationId }),
            requestId: request.id,
            remember,
            ...(sessionId === undefined ? {} : { sessionId }),
          },
          client.signal,
        )) {
          if (event.type === 'meta') messageId = event.messageId;
          if (event.type === 'refusal') refusalKind = event.kind;
          if (event.type === 'error') errorCode = event.code;
          last = event;
          if (client.signal.aborted) break;
          if (!res.write(encodeSseEvent(event, sseEventId(messageId, seq++)))) {
            // A client that stops reading must not hold a turn slot forever.
            const settle = new AbortController();
            const opts = { signal: settle.signal };
            const drained = await Promise.race([
              once(res, 'drain', opts).then(() => true),
              once(res, 'close', opts).then(() => false),
              sleep(deps.config.turnTimeoutMs, undefined, opts).then(() => false),
            ]).catch(() => false);
            // Removes the losing listeners and the timer.
            settle.abort();
            if (!drained) {
              client.abort();
              break;
            }
          }
        }
      } finally {
        if (ping !== undefined) clearInterval(ping);
        release();
        reply.raw.off('close', onClose);
        if (!res.writableEnded) res.end();
        deps.logEvent({
          event: 'turn_completed',
          requestId: request.id,
          finishReason: last?.type === 'done' ? last.finishReason : 'aborted',
          ...(refusalKind === undefined ? {} : { refusalKind }),
          ...(errorCode === undefined ? {} : { errorCode }),
          latencyMs: Math.round(deps.clock.monotonicMs() - started),
          clientAborted: client.signal.aborted,
        });
        const hint = hintFor(refusalKind, errorCode, deps.config);
        if (hint !== undefined) deps.logEvent(hint);
      }
      return reply;
    },
  );
}

/** reply.hijack() bypasses the CORS plugin's onSend hook, so the stream sets the header itself. */
function corsHeaders(
  origin: string | undefined,
  allowed: readonly string[],
): Record<string, string> {
  if (origin === undefined || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
  };
}
