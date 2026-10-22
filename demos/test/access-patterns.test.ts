// The access-patterns constructs (docs/access-patterns.md), end to end:
// nl/rasterize2.nl expresses the rasterizer with GroupBy / ReduceBy / a scan
// clause / ∷ windows — and must reproduce the classic Rasterize pipeline.
//
// Expected differences, by design:
//  - the reference's initial-state artifact spans (phantom pixel (0,0),
//    always zero-coverage) do not exist in the new constructs;
//  - coverage may differ by float reassociation (declared associativity
//    licenses it); everything else is exact.

import { describe, expect, it } from 'vitest';
import { read } from '../src/sources.js';
import { compileProgram } from '../../umgeni/src/compile.js';
import * as rt from '../../umgeni/src/cpu/runtime.js';
import { paintCoverage, textSpansParams, textTokens } from '../src/text/host.js';


const SOURCES = [
  read('gezira/types.nl'),
  read('gezira/bezier.nl'),
  read('gezira/rasterize.nl'),
  read('demos/nl/text.nl'),
  read('umgeni/nl/rasterize2.nl'),
];
const program = compileProgram(SOURCES);

function runOp(op: rt.Op, tokens: number[][]): number[][] {
  const out: number[][] = [];
  op.setEmit((t) => out.push(t));
  for (const t of tokens) op.push(t);
  op.end();
  return out;
}

// Drop the reference's leading zero-coverage artifact spans (phantom initial
// pixel), which the new constructs correctly do not emit.
function dropArtifacts(spans: number[][]): number[][] {
  let i = 0;
  while (i < spans.length && spans[i][2] === 0) i++;
  return spans.slice(i);
}

describe('the rasterizer in access-patterns Nile (nl/rasterize2.nl)', () => {
  it('compiles: GroupBy, ReduceBy, scan clause, windows', () => {
    expect(program.unsupported).toEqual([]);
    expect(program.registry.has('Rasterize2')).toBe(true);
    // The declared structure is recorded in the IR for parallel backends.
    const wind = program.ir.processes.find((p) => p.name === 'WindScan');
    expect(wind?.k === 'kernel' && wind.access?.scan).toMatchObject({ key: 1, op: '+', identity: 0 });
    const spans = program.ir.processes.find((p) => p.name === 'SpansOf');
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
    const p = compileProgram([src]);
    const out: number[][] = [];
    const op = p.registry.get('SegDiffs')!();
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
    const front = program.registry.get('TextBeziers')!(params);
    const beziers: number[][] = [];
    front.setEmit((t) => beziers.push(t));
    for (const t of textTokens('QUICK BROWN FOX')) front.push(t);
    front.end();

    const ref = dropArtifacts(runOp(program.registry.get('Rasterize')!(), beziers));
    const neu = runOp(program.registry.get('Rasterize2')!(), beziers);
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
    const p = compileProgram([src]);
    const s = runOp(p.registry.get('RunningV')!(), [[1, 10], [1, 20], [1, 5], [2, 7], [2, 1]]);
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
    const p = compileProgram([src]);
    expect(runOp(p.registry.get('Diffs')!(), [[3], [5], [4]])).toEqual([[2], [-1], [400]]);
    expect(runOp(p.registry.get('Diffs')!(), [[9]])).toEqual([[900]]);
    expect(runOp(p.registry.get('Diffs')!(), [])).toEqual([]);
  });

  it('rejects an order-sensitive kernel after a plain GroupBy', () => {
    const src = [
      ...SOURCES,
      ['Bad : Bezier >> CoverageSpan',
        '    ⇒ DecomposeBeziers → GroupBy (@y, @x) → WindScan → SpansOf'].join('\n'),
    ];
    const p = compileProgram(src);
    const bad = p.unsupported.find((u) => u.name === 'Bad');
    expect(bad?.reason).toMatch(/arrival order after a non-stable GroupBy/);
  });

  it('accepts the same kernel after GroupBy stable', () => {
    const src = [
      ...SOURCES,
      ['Ok : Bezier >> CoverageSpan',
        '    ⇒ DecomposeBeziers → GroupBy stable (@y, @x) → WindScan → SpansOf'].join('\n'),
    ];
    const p = compileProgram(src);
    expect(p.unsupported).toEqual([]);
    expect(p.registry.has('Ok')).toBe(true);
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
    const p = compileProgram(src);
    const bad = p.unsupported.find((u) => u.name === 'Bad2');
    expect(bad?.reason).toMatch(/not known to be commutative/);
  });
});
