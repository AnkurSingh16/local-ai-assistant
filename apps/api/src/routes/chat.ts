import type { SseEvent } from '@local-ai/contract';
import { chatRequestSchema, encodeSseEvent, sseEventId, ssePing } from '@local-ai/contract';
import type { FastifyInstance } from 'fastify';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

import type { AppDeps } from '../deps.js';
import { apiError } from '../http.js';
import type { TurnSlots } from '../limits.js';
import { tokenFrom } from '../sessions.js';

const defaultPingIntervalMs = 15_000;

/**
 * POST /v1/chat answers as Server-Sent Events (ADR-0007). The route sees only
 * the assistant's handleTurn, never a provider or a store (ADR-0002).
 */
export function registerChatRoute(app: FastifyInstance, deps: AppDeps, slots: TurnSlots): void {
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
