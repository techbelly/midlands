// Scan-design step 1 (docs/scan-design.md): validate that CombineEdgeSamples
// decomposes into reduce-by-key → segmented scan → pairwise window, written
// as ORDINARY sequential Nile (nl/combine-scan.nl, no new syntax), before any
// language design happens.
//
// Expected equivalence: identical span structure (positions, lengths, count);
// coverage values equal up to float reassociation — the reference interleaves
// the winding sum into per-pixel accumulation ((H+a1)+a2), the decomposition
// sums the pixel first (H+(a1+a2)). Equal in real arithmetic; the test pins
// the float gap to ≤1e-12 absolute and reports it.

import { describe, expect, it } from 'vitest';
import { read } from '../src/sources.js';
import { compileProgram } from '../../umgeni/src/compile.js';
import * as rt from '../../umgeni/src/cpu/runtime.js';
import { textSpansParams, textTokens } from '../src/text/host.js';


const program = compileProgram([
  read('gezira/types.nl'),
  read('gezira/bezier.nl'),
  read('gezira/rasterize.nl'),
  read('demos/nl/text.nl'),
  read('demos/test/fixtures/combine-scan.nl'),
]);

function runOp(op: rt.Op, tokens: number[][]): number[][] {
  const out: number[][] = [];
  op.setEmit((t) => out.push(t));
  for (const t of tokens) op.push(t);
  op.end();
  return out;
}

function decomposed(): rt.Op {
  return rt.pipeline([
    program.registry.get('SumByPixel')!(),
    program.registry.get('WindScanline')!(),
    program.registry.get('SpansOfPixels')!(),
  ]);
}

// Compare span streams: structure exactly, coverage within `tol`.
function compareSpans(actual: number[][], reference: number[][], tol: number): number {
  expect(actual.length).toBe(reference.length);
  let maxDiff = 0;
  for (let i = 0; i < reference.length; i++) {
    const [x, y, c, l] = reference[i];
    const [ax, ay, ac, al] = actual[i];
    expect([ax, ay, al], `span ${i} structure`).toEqual([x, y, l]);
    maxDiff = Math.max(maxDiff, Math.abs(ac - c));
  }
  expect(maxDiff).toBeLessThanOrEqual(tol);
  return maxDiff;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Sorted edge samples with repeated pixels (exercising the merge).
function sampleStream(seed: number, count: number): number[][] {
  const rand = lcg(seed);
  const samples: number[][] = [];
  for (let i = 0; i < count; i++) {
    samples.push([
      Math.floor(rand() * 12) + 0.5,
      Math.floor(rand() * 6) + 0.5,
      rand() * 2 - 1,
      rand() * 2 - 1,
    ]);
  }
  return samples.sort((a, b) => (a[1] !== b[1] ? a[1] - b[1] : a[0] - b[0]));
}

describe('CombineEdgeSamples ≡ SumByPixel → WindScanline → SpansOfPixels', () => {
  it('compiles the decomposition (plain sequential Nile, no new syntax)', () => {
    for (const name of ['SumByPixel', 'WindScanline', 'SpansOfPixels', 'RasterizeScan']) {
      expect(program.registry.has(name), name).toBe(true);
    }
  });

  it('bit-for-bit on single-sample pixels (no reassociation possible)', () => {
    const samples = [
      [3.5, 0.5, 0.4, 0.4], [7.5, 0.5, -0.4, -0.4],
      [2.5, 2.5, 0.9, 0.2], [3.5, 2.5, 0.1, 0.8], [9.5, 2.5, -1, -1],
    ];
    const ref = runOp(program.registry.get('CombineEdgeSamples')!(), samples);
    const dec = runOp(decomposed(), samples);
    expect(dec).toEqual(ref);
  });

  it('reproduces the reference exactly on random streams (incl. merged pixels)', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const samples = sampleStream(seed, 200);
      const ref = runOp(program.registry.get('CombineEdgeSamples')!(), samples);
      const dec = runOp(decomposed(), samples);
      compareSpans(dec, ref, 1e-12);
    }
  });

  it('reproduces the reference initial-state artifacts (first sample off-origin)', () => {
    for (const first of [[5.5, 0.5, 0.3, 0.3], [4.5, 3.5, 0.7, 0.7]]) {
      const ref = runOp(program.registry.get('CombineEdgeSamples')!(), [first]);
      const dec = runOp(decomposed(), [first]);
      expect(dec).toEqual(ref);
    }
    // Empty stream: both emit the reference's (0, 0, 0, 1) epilogue span.
    expect(runOp(decomposed(), [])).toEqual(
      runOp(program.registry.get('CombineEdgeSamples')!(), []),
    );
  });

  it('RasterizeScan matches Rasterize on real text geometry', () => {
    const params = textSpansParams({ size: 14, width: 200, height: 60, margin: 4 });
    const front = program.registry.get('TextBeziers')!(params);
    const beziers: number[][] = [];
    front.setEmit((t) => beziers.push(t));
    for (const t of textTokens('HELLO WORLD')) front.push(t);
    front.end();

    const ref = runOp(program.registry.get('Rasterize')!(), beziers);
    const dec = runOp(program.registry.get('RasterizeScan')!(), beziers);
    expect(ref.length).toBeGreaterThan(500);
    const maxDiff = compareSpans(dec, ref, 1e-12);
    // Report the actual float-reassociation gap in the test output.
    // eslint-disable-next-line no-console
    console.log(`RasterizeScan vs Rasterize: ${ref.length} spans, max coverage diff ${maxDiff.toExponential(2)}`);
  });
});
