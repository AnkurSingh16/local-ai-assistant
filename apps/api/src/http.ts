import type { FastifyReply, FastifyRequest } from 'fastify';

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
}

export function apiError(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  const body: ApiErrorBody = { error: { code, message, requestId: request.id } };
  return reply.code(status).type('application/json').send(body);
}
