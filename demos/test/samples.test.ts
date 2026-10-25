// The Cairo samples' Nile (nl/evenodd.nl, …), checked headless.
import { describe, expect, it } from 'vitest';
import { compileLibraryFile } from '../src/sources.js';
import type { Api } from '../src/vector/draw.js';
import { lowerPipeline } from '../../umgeni/src/gpu/lower.js';
import { coverageSink } from '../../umgeni/src/gpu/execute.js';
import type { FusedIR } from '../../umgeni/src/ir.js';

const library = compileLibraryFile('demos/nl/vector.nl-lib');
const nile: Api = library.api;

// A square as flat beziers, clockwise or anticlockwise.
const square = (x0: number, y0: number, x1: number, y1: number, cw = true): number[][] => {
  const pts = cw ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];
  return pts.map((p, i) => {
    const q = pts[(i + 1) % 4];
    return [p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, q[0], q[1]];
  });
};
// Coverage at pixel (x, y) from a span list.
const coverageAt = (spans: number[][], x: number, y: number): number => {
  let c = 0;
  for (const [sx, sy, sc, sl] of spans) if (Math.floor(sy) === y && Math.floor(sx) <= x && x < Math.floor(sx) + sl) c += sc;
  return c;
};

describe('the even-odd rule (nl/evenodd.nl)', () => {
  it('compiles, and lowers nothing unsupported', () => {
    expect(library.unsupported).toEqual([]);
    expect(library.registry.has('RasterizeEvenOdd')).toBe(true);
  });
  it('leaves a doubly-wound region empty where non-zero winding fills it', () => {
    const twice = [...square(2, 2, 12, 12), ...square(4, 4, 10, 10)]; // same direction: winding 2 inside
    const nonzero = nile.RasterizeParallel().run(twice);
    const evenodd = nile.RasterizeEvenOdd().run(twice);
    expect(coverageAt(nonzero, 7, 7)).toBeCloseTo(1, 9);
    expect(coverageAt(evenodd, 7, 7)).toBeCloseTo(0, 9);
    // The ring between the squares is filled under both rules.
    expect(coverageAt(nonzero, 3, 7)).toBeCloseTo(1, 9);
    expect(coverageAt(evenodd, 3, 7)).toBeCloseTo(1, 9);
  });
  it('lowers to the GPU by its declarations, like RasterizeParallel', () => {
    const ir = library.ir.processes.find((p) => p.name === 'RasterizeEvenOdd') as FusedIR;
    const plan = lowerPipeline(ir, { extent: [16, 16], sink: coverageSink });
    expect(plan.passes.length).toBe(2);
  });
  it('agrees with non-zero winding on a simple shape', () => {
    const one = square(1, 1, 9, 9);
    expect(nile.RasterizeEvenOdd().run(one)).toEqual(nile.RasterizeParallel().run(one));
  });
});
