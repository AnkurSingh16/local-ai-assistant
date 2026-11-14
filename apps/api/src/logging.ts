import type { Logger } from 'pino';
import { pino } from 'pino';

export type HintProblem =
  | 'guard_unavailable'
  | 'chat_model_unavailable'
  | 'turn_timeout'
  | 'host_rejected'
  | 'origin_rejected'
  | 'startup_guard';

/** Where the troubleshooting guide lives; every hint points to it. */
export const troubleshooting = 'docs/local-setup.md#troubleshooting';

const see = ` See ${troubleshooting}.`;

/**
 * What to do about each problem. Fixed text on purpose: a refused Host or
 * Origin may come from a hostile page, so the advice never repeats the value
 * it refused as something to allow.
 */
export const hintText: Readonly<Record<HintProblem, string>> = {
  guard_unavailable:
    'The safety model did not answer (it timed out or failed), so the turn was refused rather than answered unchecked. Check that Ollama is running and the GUARD_MODEL is loaded (ollama ps), that it is pulled, and that no other app is keeping Ollama busy. The first turn after a restart can be slow while models load.' +
    see,
  chat_model_unavailable:
    'The chat model is not answering. Start Ollama (open the app, or run: ollama serve) and pull the CHAT_MODEL (npm run doctor names it).' +
    see,
  turn_timeout:
    'A turn ran past TURN_TIMEOUT_MS. Ollama may be loading a model or busy with another app; try again once ollama ps shows both models, or raise TURN_TIMEOUT_MS.' +
    see,
  host_rejected:
    'A request used a Host header that is not in ALLOWED_HOSTS and was refused. If you did not just try to reach the API by a new address, ignore this: it is what stops DNS rebinding. To use it from a phone, find the Mac address with ipconfig getifaddr en0, add it with its port to ALLOWED_HOSTS and start the API with HOST=0.0.0.0. Logged once per run.' +
    see,
  origin_rejected:
    'A browser page whose origin is not in ALLOWED_ORIGINS was refused. If you did not just start the web app on a new port, ignore this: it is what stops other sites calling the API. To move the web app, set WEB_PORT for both the API and the web app. Logged once per run.' +
    see,
  startup_guard:
    'The safety model did not answer at start-up, so turns are refused until it does. Run npm run doctor to see why.' +
    see,
};

/** Problems any page can trigger at will, so their advice is logged only once per run. */
const oncePerRun: ReadonlySet<HintProblem> = new Set(['host_rejected', 'origin_rejected']);

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
      /**
       * A problem the operator can fix. The event carries only the problem;
       * the advice logged with it is fixed text from `hintText`, so nothing
       * from a request or a message can reach the log through it (ADR-0013).
       */
      readonly event: 'hint';
      readonly problem: HintProblem;
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
  const hinted = new Set<HintProblem>();
  return (event) => {
    if (event.event === 'hint') {
      if (oncePerRun.has(event.problem)) {
        if (hinted.has(event.problem)) return;
        hinted.add(event.problem);
      }
      logger.warn({ ...event, hint: hintText[event.problem] });
      return;
    }
    logger[event.event === 'server_exposed' ? 'warn' : 'info'](event);
  };
}
