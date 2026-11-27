// The derivative page's host code, headless: a circle looking for a letter
// by the derivative Nile gives of its own rasterizer (src/derivative/fit.ts).
import { describe, expect, it } from 'vitest';
import { compileLibraryFile, read } from '../src/sources.js';
import { agreement, circle, coverageOf, createFit, fitted, type Rasterizer } from '../src/derivative/fit.js';
import { parseTrueType } from '../src/text/ttf.js';
import { readFileSync } from 'node:fs';
import { ROOT } from '../src/sources.js';

const SIZE = 96;
const POINTS = 32;
const plain = compileLibraryFile('demos/nl/derivative.nl-lib', { target: 'wasm' });
const moving = compileLibraryFile('demos/nl/derivative.nl-lib', { directions: 2 * POINTS, target: 'wasm' });
const font = parseTrueType(new Uint8Array(readFileSync(new URL('demos/fonts/SourceSerif4.ttf', ROOT))));
const target = (ch: string) => coverageOf(plain.api.RasterizeExact().run(fitted(font.glyphFor(ch).beziers, SIZE)), SIZE);
// Where a shape ends, from a circle set down `off` pixels from the middle:
// measured by the exact rasterizer's picture of it, whichever rasterizer led.
const settle = (ch: string, rasterizer: Rasterizer, off = [0, 0]) => {
  const fit = createFit(moving, rasterizer, target(ch), circle(POINTS, SIZE / 2 + off[0], SIZE / 2 + off[1], SIZE * 0.3), { size: SIZE, points: POINTS });
  const reached = () => agreement(coverageOf(plain.api.RasterizeExact().run(fit.beziers()), SIZE), target(ch));
  const first = reached();
  while (!fit.settled) fit.advance();
  return { first, last: reached() };
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
  // has is the slope of steps about the true area (umgeni/test/exact.test.ts).
  // Followed downhill from a circle set down a hundredth of a pixel away, or
  // half a pixel, the exact rasterizer's shape ends where it did before;
  // gezira's ends somewhere else each time, and behind.
  it('ends in the same place from starts a fraction of a pixel apart, and ahead of gezira\'s', () => {
    const starts = [[0, 0], [0.01, 0], [0.5, 0.5]];
    const exact = starts.map((off) => settle('S', 'RasterizeExact', off).last);
    const snapped = starts.map((off) => settle('S', 'RasterizeParallel', off).last);
    expect(Math.max(...exact) - Math.min(...exact)).toBeLessThan(0.01);
    exact.forEach((e, i) => expect(e, `start ${i}`).toBeGreaterThan(snapped[i]));
  });
});
