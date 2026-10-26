// The access-patterns constructs (umgeni/README.md), end to end:
// roda/rasterize-parallel.nl expresses the rasterizer with GroupBy / ReduceBy / a scan
// clause / ∷ windows — and must reproduce the classic Rasterize pipeline.
//
// Expected differences, by design:
//  - the reference's initial-state artifact spans (phantom pixel (0,0),
//    always zero-coverage) do not exist in the new constructs;
//  - coverage may differ by float reassociation (declared associativity
//    licenses it); everything else is exact.

import { describe, expect, it } from 'vitest';
import { read } from '../src/sources.js';
import { compileLibrary } from '../../umgeni/src/compile.js';
import * as rt from '../../umgeni/src/cpu/runtime.js';
import { paintCoverage, textBeziers, textSpansParams } from '../src/text/host.js';


const SOURCES = [
  read('gezira/types.nl'),
  read('gezira/bezier.nl'),
  read('gezira/rasterize.nl'),
  read('gezira/texture.nl'),
  read('roda/text.nl'),
  read('roda/rasterize-parallel.nl'),
];
const library = compileLibrary(SOURCES);

// Drop the reference's leading zero-coverage artifact spans (phantom initial
// pixel), which the new constructs correctly do not emit.
function dropArtifacts(spans: number[][]): number[][] {
  let i = 0;
  while (i < spans.length && spans[i][2] === 0) i++;
  return spans.slice(i);
}

describe('the rasterizer in access-patterns Nile (roda/rasterize-parallel.nl)', () => {
  it('compiles: GroupBy, ReduceBy, scan clause, windows', () => {
    expect(library.unsupported).toEqual([]);
    expect(('RasterizeParallel' in library.api)).toBe(true);
    // The declared structure is recorded in the IR for parallel backends.
    const wind = library.ir.processes.find((p) => p.name === 'WindScan');
    expect(wind?.k === 'kernel' && wind.access?.scan).toMatchObject({ key: 1, op: '+', identity: 0 });
    const spans = library.ir.processes.find((p) => p.name === 'SpansOf');
    expect(spans?.k === 'kernel' && spans.access?.window).toEqual({ key: 1 }); // segmented by @y
  });

  it('segmented windows: pairs never span a key change; ∅ fires per segment', () => {
    const src = [
      'Pair <: (k, v : Real)',
      'SegDiffs : Pair >> Pair',
      '    ∀ p ∷ q by @k',
      '        >> (p.k, q.v - p.v)',
      '    ∀ p ∷ ∅',
      '        >> (p.k, p.v × 100)',
    ].join('\n');
    const p = compileLibrary([src]);
    const out: number[][] = [];
    const op = p.api.SegDiffs();
    op.setEmit((t) => out.push(t));
    for (const t of [[1, 10], [1, 13], [1, 20], [2, 5], [2, 6]]) op.push(t);
    op.end();
    // Segment 1: diffs 3, 7, then ∅ at the key change (20×100).
    // Segment 2: diff 1, then ∅ at flush (6×100).
    expect(out).toEqual([[1, 3], [1, 7], [1, 2000], [2, 1], [2, 600]]);
  });

  it('matches Rasterize on real text geometry (modulo artifact spans)', () => {
    const W = 220;
    const H = 60;
    const params = textSpansParams({ size: 14, width: W, height: H, margin: 4 });
    const beziers = textBeziers(library.api, 'QUICK BROWN FOX', params);

    const ref = dropArtifacts(rt.run(library.api.Rasterize(), beziers));
    const neu = rt.run(library.api.RasterizeParallel(), beziers);
    expect(neu.length).toBe(ref.length);
    let maxDiff = 0;
    for (let i = 0; i < ref.length; i++) {
      expect([neu[i][0], neu[i][1], neu[i][3]], `span ${i}`).toEqual([ref[i][0], ref[i][1], ref[i][3]]);
      maxDiff = Math.max(maxDiff, Math.abs(neu[i][2] - ref[i][2]));
    }
    expect(maxDiff).toBeLessThanOrEqual(1e-12);

    // And the painted result is the same picture.
    const a = paintCoverage(ref, W, H);
    const b = paintCoverage(neu, W, H);
    for (let i = 0; i < a.length; i++) {
      expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(1e-12);
    }
  });

  it('scan clause: exclusive running reduction, resetting per key group', () => {
    const src = [
      'Pair <: (k, v : Real)',
      'RunningV : Pair >> Pair',
      '    ∀ (k, v) with S = +[ v ] by @k',
      '        >> (k, S)',
    ].join('\n');
    const p = compileLibrary([src]);
    const s = rt.run(p.api.RunningV(), [[1, 10], [1, 20], [1, 5], [2, 7], [2, 1]]);
    // Exclusive: first of each group sees the identity.
    expect(s).toEqual([[1, 0], [1, 10], [1, 30], [2, 0], [2, 7]]);
  });

  it('windows: pair arm over adjacent tokens, end arm at flush', () => {
    const src = [
      'Diffs : Real >> Real',
      '    ∀ p ∷ q',
      '        >> q - p',
      '    ∀ p ∷ ∅',
      '        >> p × 100',
    ].join('\n');
    const p = compileLibrary([src]);
    expect(rt.run(p.api.Diffs(), [[3], [5], [4]])).toEqual([[2], [-1], [400]]);
    expect(rt.run(p.api.Diffs(), [[9]])).toEqual([[900]]);
    expect(rt.run(p.api.Diffs(), [])).toEqual([]);
  });

  it('rejects an order-sensitive kernel after a plain GroupBy', () => {
    const src = [
      ...SOURCES,
      ['Bad : Bezier >> CoverageSpan',
        '    ⇒ DecomposeBeziers → GroupBy (@y, @x) → WindScan → SpansOf'].join('\n'),
    ];
    const p = compileLibrary(src);
    const bad = p.unsupported.find((u) => u.name === 'Bad');
    expect(bad?.reason).toMatch(/arrival order after a non-stable GroupBy/);
  });

  it('accepts the same kernel after GroupBy stable', () => {
    const src = [
      ...SOURCES,
      ['Ok : Bezier >> CoverageSpan',
        '    ⇒ DecomposeBeziers → GroupBy stable (@y, @x) → WindScan → SpansOf'].join('\n'),
    ];
    const p = compileLibrary(src);
    expect(p.unsupported).toEqual([]);
    expect(('Ok' in p.api)).toBe(true);
  });

  it('rejects a non-commutative reduce on unordered groups', () => {
    const src = [
      read('gezira/types.nl'),
      [
        '(a : Real) ⊖ (b : Real) : Real',
        '    a - b',
        'Bad2 : EdgeSample >> EdgeSample',
        '    ⇒ GroupBy (@y, @x) → ReduceBy (@y, @x; a ⊕ ⊖, h ⊕ +)',
      ].join('\n'),
    ];
    // field syntax is `name ⊕ op`; ⊖ is the (non-commutative) operator
    const p = compileLibrary(src);
    const bad = p.unsupported.find((u) => u.name === 'Bad2');
    expect(bad?.reason).toMatch(/not known to be commutative/);
  });
});
