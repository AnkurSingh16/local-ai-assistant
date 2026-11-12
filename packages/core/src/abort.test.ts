import { describe, expect, it } from 'vitest';

import { isAbortError } from './abort.js';

describe('isAbortError', () => {
  it('recognises an aborted signal reason', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbortError(controller.signal.reason)).toBe(true);
  });

  it('recognises a timeout reason', () => {
    expect(isAbortError(new DOMException('late', 'TimeoutError'))).toBe(true);
  });

  it('rejects ordinary errors', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});
