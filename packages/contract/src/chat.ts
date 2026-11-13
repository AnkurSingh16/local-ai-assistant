import { z } from 'zod';

/** Longest user message accepted, in characters (ADR-0005). */
export const maxMessageChars = 4000;

/** Longest feedback, correction or preference accepted, in characters (ADR-0009). */
export const maxFeedbackChars = 1000;

export const chatRequestSchema = z.strictObject({
  message: z.string().min(1).max(maxMessageChars),
  /** Continues an earlier conversation; omitted for a new one. */
  conversationId: z.uuid().optional(),
});

export type ChatRequestBody = z.infer<typeof chatRequestSchema>;
