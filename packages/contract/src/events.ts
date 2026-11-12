import { z } from 'zod';

/** SSE events for POST /v1/chat (ADR-0007). Clients validate every event against these schemas. */

export const statusPhases = ['moderating', 'searching', 'reading', 'answering'] as const;
export const refusalKinds = ['policy', 'self_harm', 'unavailable', 'rate_limited'] as const;
export const errorCodes = ['bad_request', 'internal', 'model_unavailable', 'timeout'] as const;
export const finishReasons = ['stop', 'length', 'refused', 'error'] as const;

export const metaEventSchema = z.strictObject({
  type: z.literal('meta'),
  conversationId: z.uuid(),
  messageId: z.uuid(),
});

export const statusEventSchema = z.strictObject({
  type: z.literal('status'),
  phase: z.enum(statusPhases),
  detail: z.string().max(200).optional(),
});

export const deltaEventSchema = z.strictObject({
  type: z.literal('delta'),
  text: z.string().min(1),
});

export const citationEventSchema = z.strictObject({
  type: z.literal('citation'),
  n: z.int().min(1),
  url: z.url({ protocol: /^https$/ }),
  title: z.string().max(300),
});

export const refusalEventSchema = z.strictObject({
  type: z.literal('refusal'),
  kind: z.enum(refusalKinds),
  message: z.string().min(1),
});

export const errorEventSchema = z.strictObject({
  type: z.literal('error'),
  code: z.enum(errorCodes),
  message: z.string().min(1),
  requestId: z.string().min(1).max(100),
  retryable: z.boolean(),
});

export const doneEventSchema = z.strictObject({
  type: z.literal('done'),
  finishReason: z.enum(finishReasons),
});

export const sseEventSchema = z.discriminatedUnion('type', [
  metaEventSchema,
  statusEventSchema,
  deltaEventSchema,
  citationEventSchema,
  refusalEventSchema,
  errorEventSchema,
  doneEventSchema,
]);

export type SseEvent = z.infer<typeof sseEventSchema>;
export type SseEventType = SseEvent['type'];
export type RefusalKind = (typeof refusalKinds)[number];
export type ErrorCode = (typeof errorCodes)[number];
export type StatusPhase = (typeof statusPhases)[number];
export type FinishReason = (typeof finishReasons)[number];
