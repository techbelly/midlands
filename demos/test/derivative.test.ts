// The derivative page's host code, headless: a circle looking for a letter
// by the derivative Nile gives of its own rasterizer (src/derivative/fit.ts).
import { describe, expect, it } from 'vitest';
import { compileLibraryFile, read } from '../src/sources.js';
import { circle, coverageOf, createFit, fitted, type Rasterizer } from '../src/derivative/fit.js';
import { parseTrueType } from '../src/text/ttf.js';
import { readFileSync } from 'node:fs';
import { ROOT } from '../src/sources.js';

const SIZE = 96;
const POINTS = 32;
const plain = compileLibraryFile('demos/nl/derivative.nl-lib', { target: 'wasm' });
const moving = compileLibraryFile('demos/nl/derivative.nl-lib', { directions: 2 * POINTS, target: 'wasm' });
const font = parseTrueType(new Uint8Array(readFileSync(new URL('demos/fonts/SourceSerif4.ttf', ROOT))));
const target = (ch: string) => coverageOf(plain.api.RasterizeExact().run(fitted(font.glyphFor(ch).beziers, SIZE)), SIZE);
const settle = (ch: string, rasterizer: Rasterizer) => {
  const fit = createFit(moving, rasterizer, target(ch), circle(POINTS, SIZE / 2, SIZE / 2, SIZE * 0.3), { size: SIZE, points: POINTS });
  const first = fit.overlap;
  while (!fit.settled) fit.advance();
  return { first, last: fit.overlap, error: fit.error };
};

describe('a circle looks for a letter, by the derivative of the rasterizer', () => {
  it('has a derivative for everything the page runs', () => {
    expect(plain.unsupported).toEqual([]);
    expect(moving.unsupported).toEqual([]);
    expect(read('demos/nl/derivative.nl')).toContain('EdgeCharge');
  });

  it('finds S, C, L and 5 with the exact rasterizer', () => {
    for (const ch of ['S', 'C', 'L', '5']) {
      const { first, last } = settle(ch, 'RasterizeExact');
      expect(first, `${ch} at first`).toBeLessThan(0.6);
      expect(last, `${ch} at last`).toBeGreaterThan(0.93);
    }
  });

  // gezira's rasterizer moves each cut onto the pixel grid, so the slope it
  // has is the slope of steps about the true area (umgeni/test/exact.test.ts):
  // followed downhill it gets less far.
  it('gets less far by the derivative of gezira\'s rasterizer', () => {
    for (const ch of ['S', 'G']) {
      const exact = settle(ch, 'RasterizeExact').last, snapped = settle(ch, 'RasterizeParallel').last;
      expect(exact, ch).toBeGreaterThan(snapped + 0.05);
    }
  });
});
