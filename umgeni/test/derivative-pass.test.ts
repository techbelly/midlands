// A library compiled as its own derivative (passes/derivative.ts), held to
// the interpreter on dual numbers: the same meaning, the same arithmetic of
// duals (semantics/dual.ts), once interpreted and once compiled. Kernel by
// kernel on random streams, as agree.ts does for the values; then whole
// pipelines, the stroker's mid-stream ⇒ among them, which the compiler has
// by then turned into ordinary kernels.
import { describe, expect, it } from 'vitest';
import { compileLibrary } from '../src/compile.js';
import { parseProgram } from '../src/parser.js';
import { kernelContexts } from '../src/elaborate.js';
import { interpretKernelIn } from '../src/semantics/concrete.js';
import { dualToken, duals } from '../src/semantics/dual.js';
import { dupCat, groupBy, pipeline, reduceBy, reverse, run } from '../src/cpu/runtime.js';
import { paramWidth, shapeWidth } from '../src/values.js';
import { fixture, gezira, roda, strokeSources } from './sources.js';

let seed = 1;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
// Values that exercise branches (agree.ts), and derivatives a third of which are none.
const value = () => [0, 1, -1, 0.5, 2, 3.25, -2.75][Math.floor(random() * 7)] + (random() < 0.5 ? 0 : Math.round(random() * 160) / 16);
const moves = () => (random() < 0.3 ? 0 : value());

// The values bit for bit. The derivatives equal as numbers (a term left out
// because it is known to be zero can be -0 where the interpreter has 0),
// and only where the token's values are all finite: past a division by
// zero a derivative means nothing, and the two say different nothings.
function same(got: number[][], want: number[][], n: number, what: string): void {
  expect(got.length, `${what}: tokens`).toBe(want.length);
  got.forEach((t, i) => {
    const w = t.length / (1 + n);
    for (let j = 0; j < w; j++) expect(Object.is(t[j], want[i][j]), `${what} value ${i}.${j}: ${t[j]} vs ${want[i][j]}`).toBe(true);
    if (!want[i].slice(0, w).every(Number.isFinite)) return;
    for (let j = w; j < t.length; j++) {
      expect(t[j] === want[i][j] || (Number.isNaN(t[j]) && Number.isNaN(want[i][j])), `${what} derivative ${i}.${j}: ${t[j]} vs ${want[i][j]}`).toBe(true);
    }
  });
}

const library = ['types', 'bezier', 'stroke', 'rasterize', 'texture', 'compositor', 'gradient', 'filter'].map((n) => gezira(`${n}.nl`));
const rasterizers = [gezira('types.nl'), gezira('bezier.nl'), gezira('rasterize.nl'), gezira('texture.nl'), roda('rasterize-parallel.nl'), roda('rasterize-exact.nl')];
const PROGRAMS: [string, string[]][] = [
  ['gezira + paint scenes', [...library, fixture('paint-scenes.nl')]],
  ['the rasterizers', rasterizers],
];
const N = 2;

describe.each(PROGRAMS)('compiled derivative ≡ interpreter on duals, kernel by kernel: %s', (_, sources) => {
  const { program, kernels } = kernelContexts(parseProgram(sources).modules);
  for (const target of ['js', 'wasm'] as const) {
    const compiled = compileLibrary(sources, { directions: N, ...(target === 'wasm' ? { target } : {}) });
    it(`${target}: every kernel`, () => {
      let checked = 0;
      for (const [name, ctx] of kernels) {
        if (!(name in compiled.api)) continue;
        const pw = paramWidth(ctx.params);
        const iw = shapeWidth(ctx.stream.input);
        for (let trial = 0; trial < 12; trial++) {
          const params = Array.from({ length: pw }, value);
          const input = Array.from({ length: 1 + (trial % 6) }, () => [...Array.from({ length: iw }, value), ...Array.from({ length: iw * N }, moves)]);
          // Parameters are constants to the compiled derivative: on duals, values that do not move.
          const want = run(interpretKernelIn(duals(N), program, ctx, dualToken(params, N, () => new Array<number>(pw).fill(0))), input.map((t) => [...t]));
          same(run(compiled.api[name](params), input.map((t) => [...t])), want, N, name);
        }
        checked++;
      }
      expect(checked).toBeGreaterThan(10);
    });
  }
});

describe('compiled derivative ≡ interpreter on duals, whole pipelines', () => {
  it('RasterizeExact: fusion, GroupBy and a ReduceBy that adds each direction\'s fields', () => {
    const { program, kernels } = kernelContexts(parseProgram(rasterizers).modules, true);
    const points = [[19.1, 12.3], [14.2, 21.4], [8.7, 17.6], [3.9, 12.8], [9.3, 6.2], [16.8, 2.9]];
    const beziers = [[0, 1, 2], [2, 3, 4], [4, 5, 0]];
    const n = 2 * points.length;
    const input = beziers.map((b) => dualToken(b.flatMap((i) => points[i]), n, (d) => b.flatMap((i) => [d === 2 * i ? 1 : 0, d === 2 * i + 1 ? 1 : 0])));
    const kernel = (name: string) => interpretKernelIn(duals(n), program, kernels.get(name)!, []);
    const add = (a: number, b: number) => a + b;
    const summed = Array.from({ length: 1 + n }, (_, j) => [{ index: 4 * j + 2, fn: add }, { index: 4 * j + 3, fn: add }]).flat();
    const want = run(pipeline([kernel('MonotoneBeziers'), kernel('DecomposeExact'), groupBy([1, 0]), reduceBy([1, 0], summed), kernel('WindScan'), kernel('SpansOf')]), input.map((t) => [...t]));
    for (const target of ['js', 'wasm'] as const) {
      const compiled = compileLibrary(rasterizers, { directions: n, ...(target === 'wasm' ? { target } : {}) });
      expect(compiled.unsupported).toEqual([]);
      same(run(compiled.api.RasterizeExact([]), input.map((t) => [...t])), want, n, `RasterizeExact (${target})`);
    }
    expect(want.length).toBeGreaterThan(40);
  });

  it('StrokeBezierPath: mid-stream ⇒ compiled away, DupCat and Reverse, with its parameters constant', () => {
    const sources = strokeSources();
    const { program, kernels } = kernelContexts(parseProgram(sources).modules, true);
    const params = [3, 2, 1]; // width, miter limit, cap
    const path = [[1, 1, 5, 0.5, 9, 2], [9, 2, 12, 5, 11, 9]];
    const n = 12;
    const input = path.map((t, i) => dualToken(t, n, (d) => Array.from({ length: 6 }, (_, k) => (d === 6 * i + k ? 1 : 0))));
    const still = dualToken(params, n, () => [0, 0, 0]);
    const interp = (name: string, p: number[] = []) => interpretKernelIn(duals(n), program, kernels.get(name)!, p, (m) => kernels.get(m));
    const want = run(pipeline([
      interp('SanitizeBezierPath'),
      dupCat(interp('StrokeOneSide', still), pipeline([reverse(), interp('ReverseBeziers'), interp('StrokeOneSide', still)])),
    ]), input.map((t) => [...t]));
    for (const target of ['js', 'wasm'] as const) {
      const compiled = compileLibrary(sources, { directions: n, ...(target === 'wasm' ? { target } : {}) });
      expect(compiled.unsupported).toEqual([]);
      same(run(compiled.api.StrokeBezierPath(params), input.map((t) => [...t])), want, n, `StrokeBezierPath (${target})`);
    }
    expect(want.length).toBeGreaterThan(10);
  });
});

describe('what has no derivative says so', () => {
  it('a ReduceBy by an operator other than +, a DupZip, and what uses them', () => {
    const sources = [
      gezira('types.nl'), gezira('bezier.nl'), gezira('rasterize.nl'), gezira('texture.nl'),
      'Highest : EdgeSample >> EdgeSample\n    ⇒ GroupBy (@y) → ReduceBy (@y; a ⊕ ▷)\n',
      'Both : Point >> (Point, Point)\n    ⇒ DupZip (TransformPoints ((1, 0, 0, 1, 0, 0)), TransformPoints ((2, 0, 0, 2, 0, 0)))\n',
      'ThenHighest : Bezier >> EdgeSample\n    ⇒ DecomposeBeziers → Highest\n',
    ];
    const plain = compileLibrary(sources);
    expect(plain.unsupported).toEqual([]);
    const refused = compileLibrary(sources, { directions: 1 }).unsupported;
    expect(refused.map((u) => u.name).sort()).toEqual(['Both', 'Highest', 'ThenHighest']);
    for (const u of refused) expect(u.reason).toMatch(/^no derivative: /);
  });
});
