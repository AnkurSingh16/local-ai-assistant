/** True for the errors an aborted or timed-out signal produces, so callers can tell cancellation from failure. */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError');
}
