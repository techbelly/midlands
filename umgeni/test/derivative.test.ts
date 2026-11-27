// Nile's meaning, run on dual numbers (src/semantics/dual.ts): the equations
// of nile.mooi are the interpreter's, unchanged, and every output comes with
// its derivatives. The oracle is the interpreter itself, moved a little each
// way: a central finite difference along each direction.
//
// What this holds the derivative to is the program, not the geometry.
// DecomposeBeziers puts a split point on the pixel grid when it is within
// 0.1 of it, so the coverage gezira computes is a sawtooth about the true
// area as a control point moves, and its slope is the sawtooth's. The
// derivative here is exactly that slope.
import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/parser.js';
import { kernelContexts } from '../src/elaborate.js';
import { interpretKernelIn, reals, type Scalars } from '../src/semantics/concrete.js';
import { dualToken, duals } from '../src/semantics/dual.js';
import { groupBy, pipeline, reduceBy, run, type Op } from '../src/cpu/runtime.js';
import { gezira, roda, strokeSources } from './sources.js';

const contexts = (sources: string[]) => kernelContexts(parseProgram(sources).modules, true);

const unit = (width: number, at: number): number[] => Array.from({ length: width }, (_, i) => (i === at ? 1 : 0));

describe('RasterizeParallel on dual numbers: each pixel\'s coverage with its derivatives', () => {
  const { program, kernels } = contexts([gezira('types.nl'), gezira('bezier.nl'), gezira('rasterize.nl'), gezira('texture.nl'), roda('rasterize-parallel.nl')]);
  // The pipeline as roda/rasterize-parallel.nl says it. An EdgeSample is
  // (x, y, a, h): ReduceBy adds a and h, and so each direction's a and h.
  const rasterize = <S>(A: Scalars<S>, n: number): Op => {
    const kernel = (name: string) => interpretKernelIn(A, program, kernels.get(name)!, []);
    const add = (a: number, b: number) => a + b;
    const summed = Array.from({ length: 1 + n }, (_, j) => [{ index: 4 * j + 2, fn: add }, { index: 4 * j + 3, fn: add }]).flat();
    return pipeline([kernel('DecomposeBeziers'), groupBy([1, 0]), reduceBy([1, 0], summed), kernel('WindScan'), kernel('SpansOf')]);
  };
  // A CoverageSpan is (x, y, c, l): each pixel's coverage and its derivatives.
  const pixels = (spans: number[][], n: number): Map<string, number[]> => {
    const m = new Map<string, number[]>();
    for (const s of spans) {
      for (let i = 0; i < s[3]; i++) m.set(`${Math.floor(s[0]) + i},${Math.floor(s[1])}`, Array.from({ length: 1 + n }, (_, j) => s[4 * j + 2]));
    }
    return m;
  };

  // A closed shape: its points, and its beziers as three point indexes each.
  interface Shape { points: number[][]; beziers: number[][] }
  const tokens = ({ points, beziers }: Shape) => beziers.map((b) => b.flatMap((i) => points[i]));
  const moved = (s: Shape, direction: number, by: number): Shape => ({
    ...s,
    points: s.points.map((p, i) => (i === direction >> 1 ? [p[0] + (direction % 2 === 0 ? by : 0), p[1] + (direction % 2 === 1 ? by : 0)] : p)),
  });
  const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const V = [[2.3, 3.1], [13.7, 5.2], [6.4, 12.9]];
  const SHAPES: [string, Shape][] = [
    ['a triangle', { points: [V[0], mid(V[0], V[1]), V[1], mid(V[1], V[2]), V[2], mid(V[2], V[0])], beziers: [[0, 1, 2], [2, 3, 4], [4, 5, 0]] }],
    ['three curves', { points: [[19.1, 12.3], [14.2, 21.4], [8.7, 17.6], [3.9, 12.8], [9.3, 6.2], [16.8, 2.9]], beziers: [[0, 1, 2], [2, 3, 4], [4, 5, 0]] }],
  ];

  for (const [name, shape] of SHAPES) {
    // One direction per coordinate of each point.
    const n = 2 * shape.points.length;
    const withDerivatives = () => {
      const input = shape.beziers.map((b) => dualToken(b.flatMap((i) => shape.points[i]), n, (d) => b.flatMap((i) => [d === 2 * i ? 1 : 0, d === 2 * i + 1 ? 1 : 0])));
      return run(rasterize(duals(n), n), input);
    };

    it(`${name}: the values are the interpreter's, bit for bit`, () => {
      const want = run(rasterize(reals, 0), tokens(shape));
      const got = withDerivatives().map((t) => t.slice(0, 4));
      expect(got.length).toBe(want.length);
      got.forEach((t, i) => t.forEach((x, j) => expect(Object.is(x, want[i][j]), `span ${i}.${j}`).toBe(true)));
    });

    it(`${name}: the derivatives are the finite differences, pixel by pixel`, () => {
      const got = pixels(withDerivatives(), n);
      const h = 1e-5;
      let moving = 0;
      for (let d = 0; d < n; d++) {
        const plus = pixels(run(rasterize(reals, 0), tokens(moved(shape, d, h))), 0);
        const minus = pixels(run(rasterize(reals, 0), tokens(moved(shape, d, -h))), 0);
        for (const key of new Set([...plus.keys(), ...minus.keys(), ...got.keys()])) {
          const difference = ((plus.get(key)?.[0] ?? 0) - (minus.get(key)?.[0] ?? 0)) / (2 * h);
          const derivative = got.get(key)?.[1 + d] ?? 0;
          if (derivative !== 0) moving++;
          expect(Math.abs(derivative - difference), `pixel ${key}, direction ${d}`).toBeLessThan(1e-6);
        }
      }
      expect(moving).toBeGreaterThan(50); // the edge pixels do move
    });
  }
});

// A stroke's offset curve as its offset and its bezier move: parameters, a
// generator that becomes itself twice over (mid-stream ⇒), and √ and /.
describe('OffsetBezier on dual numbers: the offset curve with its derivatives', () => {
  const { program, kernels } = contexts(strokeSources());
  const offset = <S>(A: Scalars<S>, params: number[]) => run(interpretKernelIn(A, program, kernels.get('OffsetBezier')!, params, (n) => kernels.get(n)), []);
  const params = [1.5, 1, 1, 6, 1.5, 8, 7]; // o, then Z = (A, B, C)
  const n = params.length;

  it('the derivatives are the finite differences', () => {
    const got = offset(duals(n), dualToken(params, n, (d) => unit(n, d)));
    const want = offset(reals, params);
    expect(want.length).toBeGreaterThan(1); // it subdivided
    expect(got.map((t) => t.slice(0, 6))).toEqual(want);
    const h = 1e-6;
    for (let d = 0; d < n; d++) {
      const at = (by: number) => offset(reals, params.map((p, i) => (i === d ? p + by : p)));
      const plus = at(h), minus = at(-h);
      expect(plus.length).toBe(want.length);
      got.forEach((t, i) => {
        for (let j = 0; j < 6; j++) expect(Math.abs(t[6 * (1 + d) + j] - (plus[i][j] - minus[i][j]) / (2 * h)), `bezier ${i}.${j}, direction ${d}`).toBeLessThan(1e-6);
      });
    }
  });
});

// One side of a stroke over a stream: a process that becomes another at
// each token, with tokens pending as it does, as the width and every point
// of the path move.
describe('StrokeOneSide on dual numbers: a stream through mid-stream ⇒', () => {
  const { program, kernels } = contexts(strokeSources());
  const stroke = <S>(A: Scalars<S>, params: number[], input: number[][]) =>
    run(interpretKernelIn(A, program, kernels.get('StrokeOneSide')!, params, (n) => kernels.get(n)), input);
  const params = [3, 2, 1]; // width, miter limit, cap
  const path = [[1, 1, 5, 0.5, 9, 2], [9, 2, 12, 5, 11, 9]];
  const all = [...params, ...path.flat()];
  const n = all.length;

  it('the derivatives are the finite differences', () => {
    const got = stroke(
      duals(n),
      dualToken(params, n, (d) => unit(params.length, d)),
      path.map((t, i) => dualToken(t, n, (d) => unit(6, d - params.length - 6 * i))),
    );
    const at = (values: number[]) => stroke(reals, values.slice(0, 3), [values.slice(3, 9), values.slice(9, 15)]);
    const want = at(all);
    expect(want.length).toBeGreaterThan(2);
    expect(got.map((t) => t.slice(0, 6))).toEqual(want);
    const h = 1e-6;
    for (let d = 0; d < n; d++) {
      const plus = at(all.map((v, i) => (i === d ? v + h : v))), minus = at(all.map((v, i) => (i === d ? v - h : v)));
      expect(plus.length).toBe(want.length);
      got.forEach((t, i) => {
        for (let j = 0; j < 6; j++) expect(Math.abs(t[6 * (1 + d) + j] - (plus[i][j] - minus[i][j]) / (2 * h)), `bezier ${i}.${j}, direction ${d}`).toBeLessThan(1e-6);
      });
    }
  });
});

// What does not move has no derivative where the rule alone would not say
// so: √ at 0 is 0/0 by the rule, and still by this.
describe('dual numbers: what is still stays still', () => {
  const A = duals(2);
  const moving = (v: number) => ({ v, d: [1, 0] });
  it('through √0, and in the directions √0 does not move in', () => {
    expect(A.un('sqrt', A.num(0))).toEqual({ v: 0, d: [0, 0] });
    expect(A.un('sqrt', moving(0)).d).toEqual([Infinity, 0]);
  });
  it('and a comparison, a truth value, ⌊ ⌋ and ⌈ ⌉ of what moves are constants', () => {
    for (const op of ['lt', 'le', 'gt', 'ge', 'eq', 'ne', 'and', 'or'] as const) expect(A.bin(op, moving(1), moving(2)).d).toEqual([0, 0]);
    for (const op of ['not', 'floor', 'ceil'] as const) expect(A.un(op, moving(1.5)).d).toEqual([0, 0]);
  });
  it('a token that is not whole is refused', () => {
    expect(() => A.read([1, 2, 3, 4])).toThrow();
  });
});
