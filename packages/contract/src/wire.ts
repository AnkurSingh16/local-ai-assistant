import type { SseEvent } from './events.js';

/**
 * One SSE frame: `event`, `id` and a single-line JSON `data` field. JSON.stringify
 * escapes newlines inside strings, so the data can never break the framing.
 * The event type is repeated inside `data` so a client can validate the payload
 * alone.
 */
export function encodeSseEvent(event: SseEvent, id: string): string {
  return `event: ${event.type}\nid: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A comment line, ignored by parsers, that keeps idle proxies from closing the stream. */
export const ssePing = ': ping\n\n';

/** The event id: the message id and a per-message sequence number. */
export function sseEventId(messageId: string, seq: number): string {
  return `${messageId}:${String(seq)}`;
}
