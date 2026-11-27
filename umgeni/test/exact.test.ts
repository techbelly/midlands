// roda/rasterize-exact.nl: a rasterizer exact for the curve it is given.
// Its oracles are not rasterizers: a polygon clipped to each pixel (straight
// sides, and curves drawn as many short ones), the closed form of the area
// inside a path of quadratics, and, for the derivatives dual numbers give,
// that closed form moved a little each way. (One test differences the
// rasterizer itself, pixel by pixel, and says so.) gezira's DecomposeBeziers
// is run beside it to say how far its snap to the grid leaves it from each.
//
// The coordinates that matter are the awkward ones: on the grid, a hair off
// it, on tenths and quarters of a pixel. An earlier form of these kernels
// passed every test on random numbers and failed on those: it never ended
// on (4,4) (0,0) (1,1), and it gave a row to the wrong pixel when a piece's
// end was just under a grid line.
import { describe, expect, it } from 'vitest';
import { compileLibrary } from '../src/compile.js';
import { parseProgram } from '../src/parser.js';
import { kernelContexts } from '../src/elaborate.js';
import { interpretKernelIn, kernelSteps, reals, type Scalars } from '../src/semantics/concrete.js';
import { duals } from '../src/semantics/dual.js';
import { groupBy, pipeline, reduceBy, run, type Op } from '../src/cpu/runtime.js';
import { gezira, roda } from './sources.js';

const sources = [gezira('types.nl'), gezira('bezier.nl'), gezira('rasterize.nl'), gezira('texture.nl'), roda('rasterize-parallel.nl'), roda('rasterize-exact.nl')];
const { api } = compileLibrary(sources);
const copy = (tokens: number[][]) => tokens.map((t) => [...t]);
const spansOf = (process: string, tokens: number[][]) => run(api[process]([]), copy(tokens));
const edgeSamples = (tokens: number[][]) => run(api.DecomposeExact([]), run(api.MonotoneBeziers([]), copy(tokens)));

let seed = 1;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

type Point = [number, number];
const cross = (a: number[], b: number[]) => a[0] * b[1] - a[1] * b[0];
// A CoverageSpan is (x, y, c, l): each pixel's coverage (and, on dual
// numbers, its n derivatives).
const pixels = (spans: number[][], n = 0): Map<string, number[]> => {
  const m = new Map<string, number[]>();
  for (const s of spans) {
    for (let i = 0; i < s[3]; i++) m.set(`${Math.floor(s[0]) + i},${Math.floor(s[1])}`, Array.from({ length: 1 + n }, (_, j) => s[4 * j + 2]));
  }
  return m;
};
const total = (spans: number[][]) => spans.reduce((sum, s) => sum + s[2] * s[3], 0);

// A closed path of quadratics: its points, and each bezier as three indexes.
interface Path { points: number[][]; beziers: number[][] }
const tokens = ({ points, beziers }: Path) => beziers.map((b) => b.flatMap((i) => points[i]));
// The area inside, in closed form: half the sum of ∫ P × P' over each
// quadratic, which is (2 A×B + A×C + 2 B×C) / 3.
const area = ({ points: p, beziers }: Path) =>
  Math.abs(beziers.reduce((sum, [a, b, c]) => sum + (2 * cross(p[a], p[b]) + cross(p[a], p[c]) + 2 * cross(p[b], p[c])) / 3, 0) / 2);
// A blob round a centre, corners and control points alternating, so it does
// not cross itself.
const blob = (curves: number): Path => {
  const cx = 20 + random() * 4, cy = 20 + random() * 4;
  const points = Array.from({ length: 2 * curves }, (_, i) => {
    const angle = (i / (2 * curves)) * 2 * Math.PI, r = 6 + random() * 10;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  });
  return { points, beziers: Array.from({ length: curves }, (_, i) => [2 * i, 2 * i + 1, (2 * i + 2) % (2 * curves)]) };
};
const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const triangle = (v: number[][]): Path => ({ points: [v[0], mid(v[0], v[1]), v[1], mid(v[1], v[2]), v[2], mid(v[2], v[0])], beziers: [[0, 1, 2], [2, 3, 4], [4, 5, 0]] });

// A polygon cut to one pixel (Sutherland and Hodgman), and its area.
function inPixel(polygon: Point[], x: number, y: number): number {
  const cut = (ps: Point[], inside: (p: Point) => boolean, meet: (a: Point, b: Point) => Point): Point[] =>
    ps.flatMap((p, i) => {
      const q = ps[(i + 1) % ps.length];
      if (inside(p)) return inside(q) ? [q] : [meet(p, q)];
      return inside(q) ? [meet(p, q), q] : [];
    });
  const atX = (k: number) => (a: Point, b: Point): Point => [k, a[1] + ((b[1] - a[1]) * (k - a[0])) / (b[0] - a[0])];
  const atY = (k: number) => (a: Point, b: Point): Point => [a[0] + ((b[0] - a[0]) * (k - a[1])) / (b[1] - a[1]), k];
  let ps = cut(polygon, (p) => p[0] >= x, atX(x));
  ps = cut(ps, (p) => p[0] <= x + 1, atX(x + 1));
  ps = cut(ps, (p) => p[1] >= y, atY(y));
  ps = cut(ps, (p) => p[1] <= y + 1, atY(y + 1));
  return Math.abs(ps.reduce((sum, p, i) => sum + cross(p, ps[(i + 1) % ps.length]), 0)) / 2;
}

// A path as a polygon: each quadratic as many short sides.
const flattened = ({ points: p, beziers }: Path, sides: number): Point[] =>
  beziers.flatMap(([a, b, c]) => Array.from({ length: sides }, (_, i): Point => {
    const t = i / sides;
    return [0, 1].map((k) => p[a][k] * (1 - t) ** 2 + 2 * p[b][k] * t * (1 - t) + p[c][k] * t * t) as Point;
  }));
// The worst pixel of a path against the polygon cut to each pixel.
const worstPixel = (process: string, path: Path, polygon: Point[], size: number): number => {
  const got = pixels(spansOf(process, tokens(path)));
  let worst = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) worst = Math.max(worst, Math.abs((got.get(`${x},${y}`)?.[0] ?? 0) - inPixel(polygon, x, y)));
  }
  return worst;
};

describe('RasterizeExact: the coverage is the area', () => {
  // Corners on the grid, on halves, quarters and tenths of a pixel, and a
  // hair to either side of the grid: where an end sits on or beside a line.
  const awkward: Record<string, () => number> = {
    'on the grid': () => Math.round(random() * 16),
    'on halves': () => Math.round(random() * 32) / 2,
    'on quarters': () => Math.round(random() * 64) / 4,
    'on tenths': () => Math.round(random() * 160) / 10,
    'a hair off the grid': () => Math.round(random() * 16) * (1 + [0, 2 ** -52, -(2 ** -53), 2 ** -50][Math.floor(random() * 4)]),
  };
  for (const [kind, coordinate] of Object.entries(awkward)) {
    it(`triangles with corners ${kind}, pixel by pixel`, () => {
      let worst = 0;
      for (let trial = 0; trial < 1500; trial++) {
        const v = Array.from({ length: 3 }, () => [coordinate(), coordinate()]);
        worst = Math.max(worst, worstPixel('RasterizeExact', triangle(v), v as Point[], 17));
      }
      expect(worst).toBeLessThan(1e-11);
    });
  }

  it('the shapes an earlier form of it got wrong', () => {
    // a side through a corner of the grid left row 4 empty
    const through = [[3.75, 2.5], [3.75, 5.25], [10, 10]];
    expect(worstPixel('RasterizeExact', triangle(through), through as Point[], 12)).toBeLessThan(1e-11);
    // a top edge a hair under row 57 painted row 56 and left 57 empty
    const top = 0.57 * 100;
    const rectangle = [[1.25, top], [5.75, top], [5.75, 60], [1.25, 60]];
    const path: Path = { points: rectangle.flatMap((p, i) => [p, mid(p, rectangle[(i + 1) % 4])]), beziers: [0, 1, 2, 3].map((i) => [2 * i, 2 * i + 1, (2 * i + 2) % 8]) };
    const got = pixels(spansOf('RasterizeExact', tokens(path)));
    for (let y = 55; y < 61; y++) {
      for (let x = 0; x < 8; x++) expect(Math.abs((got.get(`${x},${y}`)?.[0] ?? 0) - inPixel(rectangle as Point[], x, y)), `pixel ${x},${y}`).toBeLessThan(1e-11);
    }
  });

  it('curves, pixel by pixel, are the curve drawn as many short sides and cut to the pixel', () => {
    let worst = 0, gezira = 0;
    for (let trial = 0; trial < 8; trial++) {
      const path = blob(3 + (trial % 5));
      const polygon = flattened(path, 400);
      worst = Math.max(worst, worstPixel('RasterizeExact', path, polygon, 42));
      gezira = Math.max(gezira, worstPixel('RasterizeParallel', path, polygon, 42));
    }
    expect(worst).toBeLessThan(1e-4); // what the short sides leave
    expect(gezira).toBeGreaterThan(0.05);
  });

  it('a triangle, pixel by pixel, is the triangle cut to the pixel', () => {
    let worst = 0, gezira = 0;
    for (let trial = 0; trial < 40; trial++) {
      const v = Array.from({ length: 3 }, () => [2 + random() * 28, 2 + random() * 28]);
      const exact = pixels(spansOf('RasterizeExact', tokens(triangle(v)))), snapped = pixels(spansOf('RasterizeParallel', tokens(triangle(v))));
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const want = inPixel(v as Point[], x, y);
          worst = Math.max(worst, Math.abs((exact.get(`${x},${y}`)?.[0] ?? 0) - want));
          gezira = Math.max(gezira, Math.abs((snapped.get(`${x},${y}`)?.[0] ?? 0) - want));
        }
      }
    }
    expect(worst).toBeLessThan(1e-11);
    expect(gezira).toBeGreaterThan(0.05); // the snap is worth this much of a pixel
  });

  it('curves: the pixels sum to the area inside, and no pixel is wound past once', () => {
    let worst = 0, gezira = 0;
    for (let trial = 0; trial < 60; trial++) {
      const path = blob(3 + (trial % 5));
      const spans = spansOf('RasterizeExact', tokens(path));
      // The winding before SpansOf clamps it: each row's running height plus
      // the pixel's own area, from the edge samples themselves.
      const rows = new Map<number, Map<number, [number, number]>>();
      for (const [x, y, a, h] of edgeSamples(tokens(path))) {
        const row = rows.get(Math.floor(y)) ?? new Map<number, [number, number]>();
        rows.set(Math.floor(y), row);
        const at = row.get(Math.floor(x)) ?? [0, 0];
        row.set(Math.floor(x), [at[0] + a, at[1] + h]);
      }
      for (const row of rows.values()) {
        let height = 0;
        for (const x of [...row.keys()].sort((p, q) => p - q)) {
          const [a, h] = row.get(x)!;
          expect(Math.abs(height + a), 'a winding').toBeLessThan(1 + 1e-9);
          height += h;
        }
        expect(Math.abs(height), 'a row closes').toBeLessThan(1e-9);
      }
      worst = Math.max(worst, Math.abs(total(spans) - area(path)));
      gezira = Math.max(gezira, Math.abs(total(spansOf('RasterizeParallel', tokens(path))) - area(path)));
    }
    expect(worst).toBeLessThan(1e-10);
    expect(gezira).toBeGreaterThan(0.1);
  });

  it('a path sliding across the grid keeps its area', () => {
    const v = [[2, 3.1], [13.7, 5.2], [6.4, 12.9]];
    for (let i = 0; i <= 400; i++) {
      const path = triangle([[2 + i / 200, 3.1], v[1], v[2]]);
      expect(Math.abs(total(spansOf('RasterizeExact', tokens(path))) - area(path))).toBeLessThan(1e-11);
    }
  });
});

describe('MonotoneBeziers → DecomposeExact: every curve ends, and says nothing empty', () => {
  it('ends on the curve an earlier form of it never left: (4,4) (0,0) (1,1)', () => {
    expect(run(api.MonotoneBeziers([]), [[4, 4, 0, 0, 1, 1]]).length).toBeLessThan(5);
    expect(edgeSamples([[4, 4, 0, 0, 1, 1]]).length).toBeLessThan(20);
  });

  // A curve is cut at most once for x and once for y, whatever rounding does:
  // on small integers, with C on the line from A to B, with C a hair from B.
  const curves: Record<string, () => number[]> = {
    'on small integers': () => Array.from({ length: 6 }, () => Math.round(random() * 8)),
    'with C on the line from A to B': () => {
      const a = [Math.round(random() * 8), Math.round(random() * 8)], b = [Math.round(random() * 8), Math.round(random() * 8)], k = random();
      return [...a, ...b, a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    },
    'with C a hair from B': () => {
      const a = [random() * 8, random() * 8], b = [random() * 8, random() * 8];
      return [...a, ...b, b[0] + (random() - 0.5) * 1e-14, b[1] + (random() - 0.5) * 1e-14];
    },
    'past where a pixel can be told from the next': () => Array.from({ length: 6 }, () => 2 ** 53 + Math.round(random() * 16) * 2),
    'smaller than any pixel': () => Array.from({ length: 6 }, () => (random() - 0.5) * 1e-320),
  };
  for (const [kind, curve] of Object.entries(curves)) {
    it(`curves ${kind}: at most four pieces each, and each run one way`, () => {
      for (let trial = 0; trial < 20000; trial++) {
        const z = curve();
        const pieces = run(api.MonotoneBeziers([]), [[...z]]);
        expect(pieces.length, `${z}`).toBeLessThanOrEqual(4);
        for (const [ax, ay, bx, by, cx, cy] of pieces) expect((bx - ax) * (cx - bx) >= 0 && (by - ay) * (cy - by) >= 0, `${z}`).toBe(true);
        expect(edgeSamples([[...z]]).length).toBeLessThan(64);
      }
    });
  }

  // What waits while a piece is cut. The GPU gives each thread a small stack:
  // a feed in tail position is taken at once and the others wait there. Cut
  // from A, the short piece is taken and only the rest waits, however long
  // the curve and whichever way it runs.
  it('never has more than a few pieces waiting, on a line 600 pixels long each way', () => {
    const { program, kernels } = kernelContexts(parseProgram(sources).modules, true);
    const steps = kernelSteps(program, kernels.get('DecomposeExact')!, []);
    const waiting = (line: number[]): number => {
      const stack: number[][] = [line];
      let most = 0;
      while (stack.length > 0) {
        let piece: number[] = stack.pop()!;
        for (;;) {
          const fed: number[][] = steps.step(piece).fed;
          if (fed.length === 0) break;
          stack.push(...fed.slice(0, -1));
          most = Math.max(most, stack.length);
          piece = fed[fed.length - 1];
        }
      }
      return most;
    };
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * 2 * Math.PI + 0.01;
      const a = [400.3, 400.7], c = [400.3 + 600 * Math.cos(angle), 400.7 + 600 * Math.sin(angle)];
      expect(waiting([...a, ...mid(a, c), ...c]), `towards ${Math.round((angle * 180) / Math.PI)}°`).toBeLessThanOrEqual(3);
    }
  });

  // Coordinates that land on the grid, beside it, far from it and nowhere.
  const kinds: Record<string, () => number> = {
    anywhere: () => random() * 40,
    'on half pixels': () => Math.round(random() * 80) / 2,
    'on the grid': () => Math.round(random() * 40),
    'beside the grid': () => Math.round(random() * 40) + (random() - 0.5) * 1e-12,
    'within one pixel': () => 10 + random() * 1e-9,
    'far apart': () => (random() - 0.5) * 2000,
  };
  for (const [kind, coordinate] of Object.entries(kinds)) {
    it(`closed paths ${kind} end, in samples that are numbers`, () => {
      for (let trial = 0; trial < (kind === 'far apart' ? 300 : 3000); trial++) {
        const p = Array.from({ length: 4 }, () => [coordinate(), coordinate()]);
        const samples = edgeSamples([[...p[0], ...p[1], ...p[2]], [...p[2], ...p[3], ...p[0]]]);
        let height = 0;
        for (const s of samples) {
          expect(s.every(Number.isFinite)).toBe(true);
          height += s[3];
        }
        expect(Math.abs(height)).toBeLessThan(1e-9);
      }
    });
  }
  it('a sample is never empty where the path is not level along the grid', () => {
    for (let trial = 0; trial < 300; trial++) {
      const samples = edgeSamples(tokens(blob(3 + (trial % 5))));
      expect(samples.filter((s) => s[2] === 0 && s[3] === 0).length).toBe(0);
    }
  });
  // An earlier form of it followed a piece towards an end at infinity, a
  // grid line at a time, for ever.
  it('what is not a number does not hang it, wherever in a curve it is', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(edgeSamples([[1, 1, bad, 5, 9, 9], [bad, bad, bad, bad, bad, bad], [1, bad, 3, 3, 5, 6]]).length).toBeGreaterThan(0);
      for (let trial = 0; trial < 3000; trial++) {
        const z = Array.from({ length: 6 }, () => (random() < 0.3 ? bad : Math.round(random() * 160) / 8));
        expect(edgeSamples([z]).length, `${z}`).toBeLessThan(200);
      }
    }
  });
});

describe('RasterizeExact on dual numbers: the derivative of the area itself', () => {
  const { program, kernels } = kernelContexts(parseProgram(sources).modules, true);
  const rasterize = <S>(A: Scalars<S>, n: number, decompose: string[]): Op => {
    const kernel = (name: string) => interpretKernelIn(A, program, kernels.get(name)!, []);
    const add = (a: number, b: number) => a + b;
    const summed = Array.from({ length: 1 + n }, (_, j) => [{ index: 4 * j + 2, fn: add }, { index: 4 * j + 3, fn: add }]).flat();
    return pipeline([...decompose.map(kernel), groupBy([1, 0]), reduceBy([1, 0], summed), kernel('WindScan'), kernel('SpansOf')]);
  };
  const EXACT = ['MonotoneBeziers', 'DecomposeExact'], GEZIRA = ['DecomposeBeziers'];
  const moved = (path: Path, direction: number, by: number): Path => ({
    ...path,
    points: path.points.map((p, i) => (i === direction >> 1 ? [p[0] + (direction % 2 === 0 ? by : 0), p[1] + (direction % 2 === 1 ? by : 0)] : p)),
  });
  // One direction for each coordinate of each point.
  const withDerivatives = (path: Path, decompose: string[]) => {
    const n = 2 * path.points.length;
    const input = path.beziers.map((b) => [
      ...b.flatMap((i) => path.points[i]),
      ...Array.from({ length: n }, (_, d) => b.flatMap((i) => [d === 2 * i ? 1 : 0, d === 2 * i + 1 ? 1 : 0])).flat(),
    ]);
    return pixels(run(rasterize(duals(n), n, decompose), input), n);
  };
  const slopes = (px: Map<string, number[]>, n: number) => Array.from({ length: n }, (_, d) => [...px.values()].reduce((sum, v) => sum + v[1 + d], 0));
  // The closed form is quadratic in the points, so its central difference is its derivative.
  const trueSlope = (path: Path, d: number) => (area(moved(path, d, 1e-3)) - area(moved(path, d, -1e-3))) / 2e-3;
  const path: Path = { points: [[19.1, 12.3], [14.2, 21.4], [8.7, 17.6], [3.9, 12.8], [9.3, 6.2], [16.8, 2.9]], beziers: [[0, 1, 2], [2, 3, 4], [4, 5, 0]] };
  const n = 2 * path.points.length;

  it('summed over the pixels it is the derivative of the area inside, where gezira\'s is not', () => {
    const exact = slopes(withDerivatives(path, EXACT), n), snapped = slopes(withDerivatives(path, GEZIRA), n);
    let worst = 0, gezira = 0;
    for (let d = 0; d < n; d++) {
      worst = Math.max(worst, Math.abs(exact[d] - trueSlope(path, d)));
      gezira = Math.max(gezira, Math.abs(snapped[d] - trueSlope(path, d)));
    }
    expect(worst).toBeLessThan(1e-9);
    expect(gezira).toBeGreaterThan(0.5);
  });

  it('pixel by pixel it is the finite difference of the rasterizer itself', () => {
    const got = withDerivatives(path, EXACT);
    const h = 1e-5;
    for (let d = 0; d < n; d++) {
      const plus = pixels(run(rasterize(reals, 0, EXACT), tokens(moved(path, d, h)))), minus = pixels(run(rasterize(reals, 0, EXACT), tokens(moved(path, d, -h))));
      for (const key of new Set([...plus.keys(), ...minus.keys(), ...got.keys()])) {
        const difference = ((plus.get(key)?.[0] ?? 0) - (minus.get(key)?.[0] ?? 0)) / (2 * h);
        expect(Math.abs((got.get(key)?.[1 + d] ?? 0) - difference), `pixel ${key}, direction ${d}`).toBeLessThan(1e-6);
      }
    }
  });

  // A limit of differentiating the branch that was taken. With a side's
  // middle exactly on a corner of the grid, the side is cut there, and both
  // pieces take the corner as their own end; moved either way, one of them
  // would be cut again. The branch taken is the one neither side takes, and
  // its derivative is not the area's. A hair away it is.
  it('a known limit: with a curve exactly through a pixel corner, the derivative is not the area\'s', () => {
    const through = triangle([[3.6, 3.1], [13.7, 5.2], [6.4, 12.9]]); // the side from (6.4, 12.9) to (3.6, 3.1) passes (5, 8)
    const beside = triangle([[3.6001, 3.1], [13.7, 5.2], [6.4, 12.9]]);
    // corner 0 moving in x takes its two sides' middles half as far
    const slope = (t: Path) => {
      const input = tokens(t).map((b, i) => [...b, ...(i === 0 ? [1, 0, 0.5, 0, 0, 0] : i === 2 ? [0, 0, 0.5, 0, 1, 0] : [0, 0, 0, 0, 0, 0])]);
      return run(rasterize(duals(1), 1, EXACT), input).reduce((sum, s) => sum + s[6] * s[3], 0);
    };
    expect(Math.abs(slope(beside) - -3.85)).toBeLessThan(1e-9);
    expect(Math.abs(slope(through) - -3.85)).toBeGreaterThan(1);
  });
});
