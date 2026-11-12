import type { Assistant } from '@local-ai/agent';
import type { Clock } from '@local-ai/core';
import type { Logger } from 'pino';

import type { Config } from './config.js';
import type { LogEventFn } from './logging.js';

export interface AppDeps {
  readonly config: Config;
  readonly assistant: Assistant;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly logEvent: LogEventFn;
  readonly newId: () => string;
  /** Reports whether the guard model answered its warm-up check (ADR-0005). */
  readonly isReady: () => boolean;
  /** Interval between SSE keep-alive comments. */
  readonly pingIntervalMs?: number;
  /** Sees every route as it is registered; the route-inventory test uses it. */
  readonly onRoute?: (route: { readonly method: string; readonly url: string }) => void;
}
