import type { Clock, ToolDefinition } from '@local-ai/core';

export const datetimeDefinition: ToolDefinition = {
  name: 'get_current_datetime',
  description: 'Get the current date and time in UTC. It needs no arguments.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

/** Reads only the injected clock (ADR-0003), so it is safe to call after web content is in context. */
export function currentDatetime(clock: Clock): string {
  const now = clock.now();
  const weekday = now.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  return `${weekday}, ${now.toISOString().replace(/\.\d{3}Z$/, 'Z')} (UTC)`;
}
