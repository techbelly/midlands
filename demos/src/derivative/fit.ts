// A shape that looks for a picture, host side (no DOM: shared by the page
// and its test).
//
// The shape is a closed curve of m quadratic beziers through m control
// points (a uniform quadratic B-spline: each bezier runs from the middle of
// one side of the control polygon to the middle of the next, by way of the
// corner between). It is rasterized by a Nile library compiled as its own
// derivative (compileLibrary with `directions`), one direction for each
// coordinate of each control point, so every pixel comes back with how its
// coverage changes as each control point moves. Nothing in the Nile knows
// this is happening: it is the rasterizer the other pages draw with.
//
// What the host adds is the looking. The error is the shape's coverage less
// the target's, pixel by pixel; its square, summed, is what is brought
// down. A pixel's coverage only moves where the outline is, so the outline
// cannot see an error it is not touching: early on the error is blurred, so
// that a mismatch some pixels away pulls on the outline, and the blur
// narrows to nothing as the fit goes on. The step is Adam's. The control
// points are respaced along their polygon now and then, so that they do
// not bunch where the curve has little to do.

import type { CompiledLibrary } from '../../../umgeni/src/compile.js';
import { dualToken } from '../../../umgeni/src/semantics/dual.js';

export type Rasterizer = 'RasterizeExact' | 'RasterizeParallel';

export interface FitOptions {
  size: number;        // the picture is size × size pixels
  points: number;      // control points, m: the library has 2m directions
  steps?: number;      // how long the blur takes to narrow, and the fit to settle
  blur?: number;       // the widest blur, in pixels
}

export interface Fit {
  readonly points: number[][];          // the control points, as they are now
  readonly coverage: Float64Array;      // the shape's picture, size × size
  readonly spans: number[][];           // the pipeline's last output: (x, y, c, l) and each direction's
  readonly gradient: Float64Array;      // how the error changes as each coordinate moves
  readonly step: number;
  readonly error: number;               // the squared error, summed
  readonly overlap: number;             // the part of shape ∪ target that is both, 0..1
  readonly settled: boolean;
  advance(): void;                      // one step downhill
  move(point: number, to: number[]): void; // a control point taken somewhere by hand
  rekindle(): void;                     // look again from here, the blur part way out
  beziers(): number[][];                // the shape as the rasterizer takes it
}

// The control points of a circle, to start from.
export const circle = (m: number, cx: number, cy: number, r: number): number[][] =>
  Array.from({ length: m }, (_, i) => [cx + r * Math.cos((i / m) * 2 * Math.PI), cy + r * Math.sin((i / m) * 2 * Math.PI)]);

// Each bezier's three points as sums of control points: [point, weight]s.
type Blend = [number, number][];
const blends = (m: number): Blend[][] =>
  Array.from({ length: m }, (_, i) => [[[(i + m - 1) % m, 0.5], [i, 0.5]], [[i, 1]], [[i, 0.5], [(i + 1) % m, 0.5]]]);

// A box blur, each way, twice over: near enough a Gaussian to see by.
function blurred(a: Float64Array, size: number, radius: number): Float64Array {
  const pass = (src: Float64Array, dx: number, dy: number): Float64Array => {
    const out = new Float64Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = x + k * dx, yy = y + k * dy;
          if (xx >= 0 && yy >= 0 && xx < size && yy < size) sum += src[yy * size + xx];
        }
        out[y * size + x] = sum / (2 * radius + 1);
      }
    }
    return out;
  };
  const once = (src: Float64Array) => pass(pass(src, 1, 0), 0, 1);
  return once(once(a));
}

export function createFit(library: CompiledLibrary, rasterizer: Rasterizer, target: Float64Array, start: number[][], opts: FitOptions): Fit {
  const { size } = opts;
  const m = opts.points;
  const n = 2 * m;
  const steps = opts.steps ?? 900;
  const widest = opts.blur ?? 8;
  const blend = blends(m);
  let q = start.map((p) => [...p]);
  const momentum = new Float64Array(n);
  const spread = new Float64Array(n);
  let turn = 0;      // Adam's count of steps since it last started
  let step = 0;      // where the fit is in its narrowing of the blur
  let coverage = new Float64Array(size * size);
  let gradient = new Float64Array(n);
  let spans: number[][] = [];
  let error = 0;
  let overlap = 0;

  // The beziers, and each with how it moves as each control point does:
  // that part never changes, so it is made once and the values put in.
  const beziers = (): number[][] => blend.map((b) => b.flatMap((terms) => [0, 1].map((c) => terms.reduce((sum, [p, wt]) => sum + q[p][c] * wt, 0))));
  const moves = blend.map((b) =>
    dualToken([0, 0, 0, 0, 0, 0], n, (d) => b.flatMap((terms) => [0, 1].map((c) => (d % 2 === c ? terms.find(([p]) => p === d >> 1)?.[1] ?? 0 : 0)))));
  const tokens = (): number[][] =>
    beziers().map((values, i) => {
      const t = moves[i].slice(); // a new array each run: the runtime keeps what it was given
      for (let k = 0; k < 6; k++) t[k] = values[k];
      return t;
    });

  const radius = () => Math.round(widest * Math.max(0, 1 - step / (steps * 0.7)));

  // The picture as it is, and which way is down.
  function look(): void {
    spans = library.api[rasterizer]().run(tokens());
    coverage = new Float64Array(size * size);
    const each = (f: (s: number[], at: number) => void) => {
      for (const s of spans) {
        const y = Math.floor(s[1]);
        if (y < 0 || y >= size) continue;
        for (let i = 0; i < s[3]; i++) {
          const x = Math.floor(s[0]) + i;
          if (x >= 0 && x < size) f(s, y * size + x);
        }
      }
    };
    each((s, at) => (coverage[at] = s[2]));
    const wrong = new Float64Array(size * size);
    error = 0;
    let both = 0, either = 0;
    for (let i = 0; i < size * size; i++) {
      wrong[i] = coverage[i] - target[i];
      error += wrong[i] * wrong[i];
      both += Math.min(coverage[i], target[i]);
      either += Math.max(coverage[i], target[i]);
    }
    overlap = either > 0 ? both / either : 0;
    // What each pixel of the outline is to answer for: the error about it.
    const r = radius();
    const seen = r > 0 ? blurred(wrong, size, r) : wrong;
    gradient = new Float64Array(n);
    each((s, at) => {
      const e = 2 * seen[at];
      if (e === 0) return;
      for (let j = 0; j < n; j++) {
        const d = s[4 * (j + 1) + 2]; // direction j's copy of c
        if (d !== 0) gradient[j] += e * d;
      }
    });
  }

  // The control points spaced evenly along their own polygon.
  function respace(): void {
    const side = q.map((p, i) => Math.hypot(q[(i + 1) % m][0] - p[0], q[(i + 1) % m][1] - p[1]));
    const round = side.reduce((a, b) => a + b, 0);
    const next: number[][] = [];
    let at = 0, from = 0;
    for (let i = 0; i < m; i++) {
      const along = (i / m) * round;
      while (from + side[at] < along) from += side[at++];
      const f = (along - from) / (side[at] || 1), a = q[at], b = q[(at + 1) % m];
      next.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
    q = next;
    momentum.fill(0);
  }

  function advance(): void {
    step++;
    turn++;
    // A little pull of each control point towards the middle of its
    // neighbours, so the polygon stays a polygon.
    for (let i = 0; i < m; i++) {
      for (const c of [0, 1]) gradient[2 * i + c] += 0.12 * (2 * q[i][c] - q[(i + m - 1) % m][c] - q[(i + 1) % m][c]);
    }
    for (let j = 0; j < n; j++) {
      momentum[j] = 0.9 * momentum[j] + 0.1 * gradient[j];
      spread[j] = 0.999 * spread[j] + 0.001 * gradient[j] * gradient[j];
      q[j >> 1][j & 1] -= (0.25 * (momentum[j] / (1 - 0.9 ** turn))) / (Math.sqrt(spread[j] / (1 - 0.999 ** turn)) + 1e-8);
    }
    if (step % 20 === 0 && step < steps * 0.8) respace();
    look();
  }

  look();
  return {
    get points() { return q; },
    get coverage() { return coverage; },
    get spans() { return spans; },
    get gradient() { return gradient; },
    get step() { return step; },
    get error() { return error; },
    get overlap() { return overlap; },
    get settled() { return step >= steps; },
    advance,
    move(point, to) {
      q[point] = [...to];
      momentum.fill(0);
      look();
    },
    rekindle() {
      step = Math.min(step, Math.round(steps * 0.45));
      turn = 0;
      momentum.fill(0);
      spread.fill(0);
    },
    beziers,
  };
}

// A target to look for: beziers fitted to the middle of the page (most of
// its width or height, whichever is the larger), and their coverage.
export function fitted(beziers: number[][], size: number, part = 0.76): number[][] {
  const xs = beziers.flatMap((b) => [b[0], b[2], b[4]]), ys = beziers.flatMap((b) => [b[1], b[3], b[5]]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = (size * part) / Math.max(x1 - x0, y1 - y0);
  // A fraction of a pixel off centre, so that no straight side lies along the grid.
  const ox = size / 2 - (k * (x0 + x1)) / 2 + 0.137, oy = size / 2 - (k * (y0 + y1)) / 2 + 0.271;
  return beziers.map((b) => b.map((v, i) => (i % 2 === 0 ? ox + k * v : oy + k * v)));
}

export function coverageOf(spans: number[][], size: number): Float64Array {
  const c = new Float64Array(size * size);
  for (const s of spans) {
    const y = Math.floor(s[1]);
    if (y < 0 || y >= size) continue;
    for (let i = 0; i < s[3]; i++) {
      const x = Math.floor(s[0]) + i;
      if (x >= 0 && x < size) c[y * size + x] = s[2];
    }
  }
  return c;
}
