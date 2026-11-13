import { describe, expect, it } from 'vitest';

import { cosineSimilarity } from './similarity.js';

describe('cosineSimilarity', () => {
  it('scores identical vectors 1, orthogonal 0, and empty or zero vectors 0', () => {
    expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([2, 4]))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
    expect(cosineSimilarity(new Float32Array(0), new Float32Array(0))).toBe(0);
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
});
