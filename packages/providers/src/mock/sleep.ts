import { setTimeout as delay } from 'node:timers/promises';

/** Waits without blocking cancellation: an abort rejects at once with the signal's reason. */
export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (ms <= 0) return;
  try {
    await delay(ms, undefined, { signal });
  } catch (err) {
    // timers/promises rejects with its own AbortError; surface the signal's reason
    // so callers see the same error whether the abort came before or during the wait.
    signal.throwIfAborted();
    throw err;
  }
}
