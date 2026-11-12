import type { Logger } from 'pino';
import { pino } from 'pino';

/**
 * Every log line is one of these closed shapes (ADR-0013). None has a field
 * for message text, page content or personal data, so they cannot be logged
 * by accident; pino's redact list below is only a backstop.
 */
export type LogEvent =
  | {
      readonly event: 'server_started';
      readonly host: string;
      readonly port: number;
      readonly providers: 'ollama' | 'mock';
    }
  | { readonly event: 'server_exposed'; readonly host: string }
  | { readonly event: 'guard_warmup'; readonly ok: boolean; readonly latencyMs: number }
  | {
      readonly event: 'request_rejected';
      readonly requestId: string;
      readonly route: string;
      readonly status: number;
      readonly reason: 'host' | 'origin' | 'validation' | 'busy' | 'rate_limited';
    }
  | {
      readonly event: 'turn_completed';
      readonly requestId: string;
      readonly finishReason: string;
      readonly refusalKind?: string;
      readonly errorCode?: string;
      readonly latencyMs: number;
      readonly clientAborted: boolean;
    };

export type LogEventFn = (event: LogEvent) => void;

export const redactPaths = [
  'req.body',
  'req.query',
  'req.headers.authorization',
  'req.headers.cookie',
  '*.text',
  '*.content',
  '*.message',
  '*.prompt',
];

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: { paths: redactPaths, censor: '[redacted]' },
    ...(pretty ? { transport: { target: 'pino-pretty' } } : {}),
  });
}

export function createLogEvent(logger: Logger): LogEventFn {
  return (event) => {
    const level = event.event === 'server_exposed' ? 'warn' : 'info';
    logger[level](event);
  };
}
