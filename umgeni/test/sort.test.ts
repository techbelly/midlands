import { describe, expect, it } from 'vitest';
import { sortTokens, type Token } from '../src/runtime.js';

// Reference: a by-construction stable sort (decorate with index).
function referenceSort(tokens: Token[], k: number): Token[] {
  return tokens
    .map((t, i) => ({ t, i }))
    .sort((p, q) => (p.t[k] !== q.t[k] ? p.t[k] - q.t[k] : p.i - q.i))
    .map((p) => p.t);
}

// Tokens carry a payload slot so stability violations are observable.
function tokensFrom(keys: number[]): Token[] {
  return keys.map((key, i) => [key, i]);
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('sortTokens', () => {
  it('matches a reference stable sort on half-integer scanline keys', () => {
    const rand = lcg(1);
    const keys = Array.from({ length: 500 }, () => Math.floor(rand() * 40) + 0.5);
    expect(sortTokens(tokensFrom(keys), 0)).toEqual(referenceSort(tokensFrom(keys), 0));
  });

  it('handles mixed fractional keys sharing an integer part', () => {
    const rand = lcg(2);
    const keys = Array.from({ length: 300 }, () => Math.floor(rand() * 20) + Math.round(rand() * 4) / 4);
    expect(sortTokens(tokensFrom(keys), 0)).toEqual(referenceSort(tokensFrom(keys), 0));
  });

  it('falls back to a plain stable sort for wide or non-finite key ranges', () => {
    const wide = [5e9, -3e9, 12, 5e9, 0, -3e9].map((k, i) => [k, i] as Token);
    expect(sortTokens([...wide], 0)).toEqual(referenceSort(wide, 0));
  });

  it('sorts by the given field offset, not the first', () => {
    const tokens: Token[] = [[9, 2.5, 0], [1, 0.5, 1], [5, 2.5, 2], [7, 1.5, 3]];
    expect(sortTokens([...tokens], 1)).toEqual(referenceSort(tokens, 1));
  });

  it('handles empty and single-token buffers', () => {
    expect(sortTokens([], 0)).toEqual([]);
    expect(sortTokens([[3, 0]], 0)).toEqual([[3, 0]]);
  });
});
