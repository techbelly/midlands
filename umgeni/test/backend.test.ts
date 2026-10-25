import { describe, expect, it } from 'vitest';
import { gezira } from './sources.js';
import { compileLibrary, makeStreamer } from '../src/compile.js';
import { tokenType } from '../src/cpu/runtime.js';


describe('generated kernels', () => {
  it('runs a stateful running sum with epilogue', () => {
    const src = [
      'RunningSum : Real >> Real',
      '    s = 0',
      '    ∀ a',
      "        s' = s + a",
      "        >> s'",
      '    >> s × 10',
    ].join('\n');
    const library = compileLibrary([src]);
    const s = makeStreamer(library, 'RunningSum');
    expect(s.push([1])).toEqual([[1]]);
    expect(s.push([2])).toEqual([[3]]);
    expect(s.push([4])).toEqual([[7]]);
    expect(s.end()).toEqual([[70]]);
  });

  it('broadcasts scalars into records and lifts operators componentwise', () => {
    const src = [
      'Point <: (x, y : Real)',
      'Shift (d : Real) : Point >> Point',
      '    ∀ P',
      '        >> P + d',
    ].join('\n');
    const s = makeStreamer(compileLibrary([src]), 'Shift', [10]);
    expect(s.push([1, 2])).toEqual([[11, 12]]);
  });

  it('selects per component when a guard condition is record-valued', () => {
    // max via ▷ lifted over Point: each component picks independently.
    const src = [
      'Point <: (x, y : Real)',
      '(a : Real) ▷ (b : Real) : Real',
      '    { a if a > b, b }',
      'ClampLow (m : Point) : Point >> Point',
      '    ∀ P',
      '        >> P ▷ m',
    ].join('\n');
    const s = makeStreamer(compileLibrary([src]), 'ClampLow', [0, 5]);
    expect(s.push([3, 3])).toEqual([[3, 5]]);
    expect(s.push([-1, 7])).toEqual([[0, 7]]);
  });

  it('runs a prologue-seeded generator (RectangleSpans)', () => {
    const library = compileLibrary([gezira('types.nl'), gezira('rasterize.nl')]);
    const s = makeStreamer(library, 'RectangleSpans', [0, 0, 2, 2]);
    // Seed (0.5, 0.5); each row emits a span and feeds the next row down.
    expect(s.end()).toEqual([
      [0.5, 0.5, 1, 2],
      [0.5, 1.5, 1, 2],
    ]);
  });

  it('runs feedback subdivision to a fixpoint (DecomposeBeziers on a curve)', () => {
    const library = compileLibrary([gezira('types.nl'), gezira('rasterize.nl')]);
    const s = makeStreamer(library, 'DecomposeBeziers');
    const out = [...s.push([0, 0, 1, 2, 2, 0]), ...s.end()];
    expect(out.length).toBeGreaterThan(2);
    // Every edge sample lands on a pixel centre with |area| ≤ 1.
    for (const [x, y, a] of out) {
      expect(x - Math.floor(x)).toBeCloseTo(0.5, 12);
      expect(y - Math.floor(y)).toBeCloseTo(0.5, 12);
      expect(Math.abs(a)).toBeLessThanOrEqual(1.000001);
    }
    // A path returning to y=0 has zero net winding in h.
    const hSum = out.reduce((n, t) => n + t[3], 0);
    expect(hSum).toBeCloseTo(0, 9);
  });

  it('computes bounds via primed state updated only on some tokens', () => {
    const library = compileLibrary([gezira('types.nl'), gezira('bezier.nl')]);
    const s = makeStreamer(library, 'CalculateBounds');
    s.push([1, 2, 3, 9, 5, 4]);
    s.push([0, 7, 0, 7, 0, 7]); // horizontal: ignored by the ¬(…) guard
    expect(s.end()).toEqual([[1, 2, 5, 9]]);
  });

  it('exposes the generated JS source as an inspectable artifact', () => {
    const library = compileLibrary([gezira('types.nl'), gezira('rasterize.nl')]);
    expect(library.source).toContain('R["DecomposeBeziers"]');
    expect(library.source).toContain('rt.sortBy([1, 0])'); // SortBy (@x) → SortBy (@y), fused: one sort by (y, x)
  });

  it('compiles all of stroke.nl: mid-stream ⇒, generators, DupCat, Reverse', () => {
    const library = compileLibrary([gezira('types.nl'), gezira('bezier.nl'), gezira('stroke.nl')]);
    expect(library.unsupported).toEqual([]);
    expect(library.registry.has('StrokeBezierPath')).toBe(true); // checked vs the original in stroke-oracle.test.ts
  });

  it('reports unsupported constructs honestly instead of miscompiling', () => {
    // The gezira corpus has none left; a scan clause on a window arm (an
    // Umgeni-extension combination) is still unimplemented.
    const scanWindow = 'Pick : Point >> Real\n    ∀ p ∷ q with H = +[ p.x ] by @y\n        >> H\n';
    const library = compileLibrary([gezira('types.nl'), gezira('texture.nl'), scanWindow]);
    expect(library.unsupported.map((u) => u.name)).toEqual(['Pick']);
    // Everything else in the same library still compiles.
    expect(library.registry.has('RepeatTexture')).toBe(true);
    expect(library.templates).toContain('CompositeTextures'); // process-typed: instantiated at use
  });
});

describe('dependency honesty', () => {
  it('a pipeline using a process that failed to compile is unsupported too', () => {
    const src = [
      'Bad : Real >> Real\n    ∀ x\n        >> nope\n',
      'UsesBad : Real >> Real\n    ⇒ Bad → Bad\n',
      'UsesUsesBad : Real >> Real\n    ⇒ UsesBad\n',
    ].join('\n');
    const library = compileLibrary([src]);
    expect(library.unsupported.map((u) => u.name).sort()).toEqual(['Bad', 'UsesBad', 'UsesUsesBad']);
    expect(library.unsupported.find((u) => u.name === 'UsesUsesBad')!.reason).toMatch(/UsesBad/);
  });
});

describe('patterns', () => {
  const run = (src: string, name: string, tokens: number[][]) => {
    const library = compileLibrary([src]);
    expect(library.unsupported).toEqual([]);
    const s = makeStreamer(library, name);
    return [...tokens.flatMap((t) => s.push(t)), ...s.end()];
  };

  it('destructures nested tuple patterns in ∀', () => {
    const src = 'Pt <: (x, y : Real)\nSeg <: (a, b : Pt)\nDx : Seg >> Real\n    ∀ ((x0, _), (x1, _))\n        >> x1 - x0\n';
    expect(run(src, 'Dx', [[1, 2, 5, 9]])).toEqual([[4]]);
  });

  it('binds tuple patterns in statements, prologue state, and primed updates', () => {
    const src = [
      'Fib : Real >> Real',
      '    (a, b) = (0, 1)', // prologue: two state slots
      '    ∀ _',
      "        (s, d) = (a + b, b - a)",
      "        (a', b') = (b, s)",
      '        >> d',
      '',
    ].join('\n');
    // d = b - a before each step: 1, 0, 1, 1, 2
    expect(run(src, 'Fib', [[0], [0], [0], [0], [0]]).flat()).toEqual([1, 0, 1, 1, 2]);
  });

  it('destructures window patterns', () => {
    const src = 'Pt <: (x, y : Real)\nRun : Pt >> Real\n    ∀ (x, _) ∷ (u, _)\n        >> u - x\n';
    expect(run(src, 'Run', [[1, 0], [4, 0], [9, 0]]).flat()).toEqual([3, 5]);
  });
});

describe('named parameters', () => {
  const library = compileLibrary([gezira('types.nl'), gezira('bezier.nl')]);
  const run = (P: Parameters<typeof makeStreamer>[2]) => {
    const s = makeStreamer(library, 'TransformBeziers', P);
    return [...s.push([1, 2, 3, 4, 5, 6]), ...s.end()];
  };
  const M = [2, 0, 0, 3, 10, 20];

  it('records each process signature in the IR', () => {
    expect(library.ir.signatures.TransformBeziers).toEqual([{ name: 'M', width: 6 }]);
  });

  it('takes parameters by name, the same as flat', () => {
    expect(run({ M })).toEqual(run(M));
    expect(run({ M: [[2, 0], [0, 3], [10, 20]] })).toEqual(run(M)); // nested arrays flatten
  });

  it('names what is wrong', () => {
    expect(() => run({})).toThrow("missing 'M': TransformBeziers takes M (6)");
    expect(() => run({ M, N: 1 })).toThrow("unknown 'N'");
    expect(() => run({ M: [1, 2] })).toThrow("'M' needs 6 number(s), got 2");
  });
});

describe('token types', () => {
  const library = compileLibrary([gezira('types.nl'), gezira('bezier.nl'), gezira('rasterize.nl')]);

  it('records every named record type with its field layout', () => {
    expect(library.ir.types.Point).toEqual({ width: 2, fields: { x: { at: 0, width: 1 }, y: { at: 1, width: 1 } } });
    expect(library.ir.types.Bezier.width).toBe(6);
    expect(library.ir.types.Bezier.fields['C.y']).toEqual({ at: 5, width: 1 });
  });

  it('reads and builds tokens by field name, from the registry', () => {
    const Bezier = tokenType(library.registry, 'Bezier');
    const t = Bezier.make({ A: [1, 2], B: [3, 4], C: [5, 6] });
    expect(t).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Bezier.get(t, 'B')).toEqual([3, 4]);
    expect(Bezier.get(t, 'C.x')).toBe(5);
    expect(t[Bezier.at('A.y')]).toBe(2);
  });

  it('names what is wrong', () => {
    const Bezier = tokenType(library.registry, 'Bezier');
    expect(() => Bezier.at('D')).toThrow("'D' is not a field of Bezier");
    expect(() => Bezier.make({ A: [1, 2], B: [3, 4] })).toThrow("missing 'C': Bezier has A (2), B (2), C (2)");
    expect(() => tokenType(library.registry, 'Beziers')).toThrow("no record type named 'Beziers'");
  });
});

describe('the library API', () => {
  const nile = compileLibrary([gezira('types.nl'), gezira('bezier.nl')]).api;

  it('runs a process by name, parameters by name', () => {
    expect(nile.TransformBeziers({ M: [2, 0, 0, 3, 10, 20] }).run([[1, 2, 3, 4, 5, 6]])).toEqual([[12, 26, 16, 32, 20, 38]]);
  });

  it('carries the token types', () => {
    expect(nile.types.Bezier.make({ A: [1, 2], B: [3, 4], C: [5, 6] })).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('processes the host supplies', () => {
  // Declared by signature alone, with parameters: the host defines it.
  const src = [
    'Scale :: (k : Real) : Real >> Real',
    'Twice : Real >> Real',
    '    ⇒ Scale (2) → Scale (3)',
    'Shift (d : Real) : Real >> Real',
    '    ∀ x',
    '        >> x + d',
    'Both (d : Real) : Real >> Real',
    '    ⇒ Shift (d) → Scale (10)',
  ].join('\n');
  const scale = (P: number[]) => {
    let emit: (t: number[]) => void = () => {};
    return { push: (t: number[]) => emit([t[0] * P[0]]), end() {}, setEmit: (e: (t: number[]) => void) => { emit = e; } };
  };
  it('compiles a pipeline that uses one, and names it when it is missing', () => {
    const library = compileLibrary([src]);
    expect(library.unsupported).toEqual([]);
    expect(library.ir.host).toEqual([{ name: 'Scale', paramWidth: 1, inputWidth: 1, outputWidth: 1 }]);
    expect(() => library.api.Twice().run([[1]])).toThrow(/'Scale' is a process the host supplies/);
  });
  it('runs it once provided, by name, among compiled kernels', () => {
    const library = compileLibrary([src]);
    library.api.provide('Scale', scale);
    expect(library.api.Twice().run([[1], [2]])).toEqual([[6], [12]]);
    expect(library.api.Both({ d: 1 }).run([[1], [2]])).toEqual([[20], [30]]);
    expect(library.api.Scale({ k: 4 }).run([[2]])).toEqual([[8]]); // its parameters by name, too
    expect(() => library.api.provide('Shift', scale)).toThrow(/not a process the host supplies/);
  });
});
