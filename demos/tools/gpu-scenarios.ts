// The GPU checks' scenarios: what the CPU computes, what the GPU computes,
// and how the two are compared. Shared by the Deno checks, which run a real
// GPU against the CPU live, and the Node test gpu-oracle.test.ts, which runs
// the CPU against the GPU's recorded answers in
// demos/test/fixtures/gpu-oracle.json. CI has no GPU; the recording holds
// the lowering to what a GPU last produced, the way the 2012 runtime's
// answers hold the kernels. `npm run record:gpu` refreshes it.
//
// Nothing here touches a device at import time: readback.ts is imported
// inside gpu(), so Node can load the scenarios for their CPU side.

import { compileLibrary, type CompiledLibrary } from '../../umgeni/src/compile.js';
import { compileLibraryFile, librarySourceTexts } from '../src/sources.js';
import { lowerPipeline, type Plan, type Sink } from '../../umgeni/src/gpu/lower.js';
import { appendSink } from '../../umgeni/src/gpu/execute.js';
import { framePlan } from '../../umgeni/src/gpu/present.js';
import { fusedPipeline, type ModuleIR } from '../../umgeni/src/ir.js';
import { paintCoverage, textBeziers, textSpansParams } from '../src/text/host.js';
import { square } from '../test/fixtures.js';
import { lineCubic } from '../src/samples/path.js';

export type Result = { kind: 'coverage'; data: ArrayLike<number> } | { kind: 'tokens'; rows: number[][] };

export interface Scenario {
  what: string;
  /** The CPU's answer. Absent for a GPU-against-GPU check, which only Deno runs. */
  cpu?: () => Result;
  /** The reference when there is no CPU side: another GPU result. */
  reference?: (device: GPUDevice) => Promise<Result>;
  gpu: (device: GPUDevice) => Promise<Result>;
  /** Throws naming what failed; returns the one line to log when it did not. */
  compare: (what: string, expected: Result, got: Result) => string;
}

// The named fused pipeline, lowered to accumulate coverage over a W × H image.
export const coveragePlan = (ir: ModuleIR, name: string, W: number, H: number): Plan => framePlan(fusedPipeline(ir, name), W, H);

// --- comparisons ---

// Two coverage images: the largest and mean difference, and how many pixels
// the CPU covers (a bound on what the check drew at all).
export function coverageDiff(cpu: ArrayLike<number>, gpu: ArrayLike<number>): { max: number; mean: number; covered: number } {
  let max = 0;
  let sum = 0;
  let covered = 0;
  for (let i = 0; i < cpu.length; i++) {
    const d = Math.abs(cpu[i] - gpu[i]);
    max = Math.max(max, d);
    sum += d;
    if (cpu[i] > 0.5) covered++;
  }
  return { max, mean: sum / cpu.length, covered };
}

const coverageOf = (r: Result): ArrayLike<number> => {
  if (r.kind !== 'coverage') throw new Error(`expected coverage, got ${r.kind}`);
  return r.data;
};
const rowsOf = (r: Result): number[][] => {
  if (r.kind !== 'tokens') throw new Error(`expected tokens, got ${r.kind}`);
  return r.rows;
};

// The two agree to the tolerance, and the expected side covered a plausible
// number of pixels.
export const compareCoverage = (tolerance: number, covered: { min: number; max?: number }) => (what: string, expected: Result, got: Result): string => {
  const cpu = coverageOf(expected), gpu = coverageOf(got);
  if (cpu.length !== gpu.length) throw new Error(`${what}: ${cpu.length} cells expected, ${gpu.length} got`);
  const d = coverageDiff(cpu, gpu);
  if (d.covered < covered.min || (covered.max !== undefined && d.covered > covered.max)) {
    const range = covered.max === undefined ? `at least ${covered.min}` : `${covered.min}..${covered.max}`;
    throw new Error(`${what}: ${d.covered} covered pixels, expected ${range}`);
  }
  if (d.max > tolerance) throw new Error(`${what}: CPU and GPU disagree, max ${d.max.toFixed(4)} > ${tolerance}`);
  return `${what}: ok, ${d.covered} px covered, max diff ${d.max.toFixed(4)}`;
};

// Tokens as a map by pixel, for two streams whose order differs: the same
// pixels, and the given fields within the tolerance.
const byPixel = (ts: number[][]) => new Map(ts.map((t) => [`${Math.floor(t[0])},${Math.floor(t[1])}`, t]));
export const comparePixels = (fields: number[], tolerance: number) => (what: string, expected: Result, got: Result): string => {
  const a = byPixel(rowsOf(expected)), b = byPixel(rowsOf(got));
  if (a.size !== b.size) throw new Error(`${what}: CPU has ${a.size} pixels, GPU ${b.size}`);
  let max = 0;
  for (const [k, t] of a) {
    const u = b.get(k);
    if (!u) throw new Error(`${what}: pixel ${k} is missing on the GPU`);
    for (const f of fields) max = Math.max(max, Math.abs(t[f] - u[f]));
  }
  if (max > tolerance) throw new Error(`${what}: CPU and GPU disagree, max ${max.toFixed(5)} > ${tolerance}`);
  return `${what}: ok, ${a.size} pixels, max diff ${max.toFixed(5)}`;
};

// The same multiset of tokens, order unspecified (threads finish as they
// finish): compared as sorted lists of keys.
export const compareMultiset = (key: (t: ArrayLike<number>) => string) => (what: string, expected: Result, got: Result): string => {
  const cpu = rowsOf(expected), gpu = rowsOf(got);
  if (gpu.length !== cpu.length) throw new Error(`${what}: GPU emitted ${gpu.length} tokens, CPU ${cpu.length}`);
  const a = cpu.map(key).sort();
  const b = gpu.map(key).sort();
  const differ = a.filter((k, i) => k !== b[i]).length;
  if (differ > 0) throw new Error(`${what}: ${differ} of ${gpu.length} tokens differ`);
  return `${what}: ok, ${gpu.length} tokens, same multiset as the CPU`;
};

// --- the recording ---

// A coverage image is mostly zero, so it is stored sparse: [i, v, i, v, …].
// Tokens are stored as they are. The values are the GPU's f32s, written with
// nine significant digits, which is enough to read them back exactly.
export type Recorded = { kind: 'coverage'; length: number; sparse: number[] } | { kind: 'tokens'; rows: number[][] };
export interface Oracle {
  recorded: { on: string; by: string };
  results: Record<string, Recorded>;
}
export const ORACLE_FILE = 'demos/test/fixtures/gpu-oracle.json';

const f32 = (x: number): number => Number(Math.fround(x).toPrecision(9));
export function pack(r: Result): Recorded {
  if (r.kind === 'tokens') return { kind: 'tokens', rows: r.rows.map((t) => Array.from(t, f32)) };
  const sparse: number[] = [];
  for (let i = 0; i < r.data.length; i++) if (r.data[i] !== 0) sparse.push(i, f32(r.data[i]));
  return { kind: 'coverage', length: r.data.length, sparse };
}

export function unpack(r: Recorded): Result {
  if (r.kind === 'tokens') return r;
  const data = new Float32Array(r.length);
  for (let i = 0; i < r.sparse.length; i += 2) data[r.sparse[i]] = r.sparse[i + 1];
  return { kind: 'coverage', data };
}

// --- the scenarios ---

const once = <T>(f: () => T): (() => T) => {
  let v: T | undefined, done = false;
  return () => (done ? v! : ((v = f()), (done = true), v));
};
const compiled = (library: CompiledLibrary): CompiledLibrary => {
  if (library.unsupported.length > 0) throw new Error(JSON.stringify(library.unsupported));
  return library;
};
const readback = () => import('../../umgeni/src/gpu/readback.js');

// The lowering is a compiler, not a template: pipelines it has never seen
// lower from their declarations and agree with the CPU. Three shapes beyond
// RasterizeParallel, each against the same Nile run by the JS backend:
//
//   RasterizePixels   a feedback kernel (ExpandSpans) after the window, and a
//                     per-pixel sink in place of the span loop
//   RasterizeMapped   a parameterized map kernel (TransformBeziers (M)) fused
//                     ahead of the worklist pass
//   Expand            ExpandSpans alone, one pass, output appended to a buffer
const lowering = once(() => {
  const library = compiled(compileLibrary([
    ...librarySourceTexts('demos/nl/text.nl-lib'),
    // Two pipelines the lowering has not been written against.
    'RasterizeMapped (M : Matrix) : Bezier >> CoverageSpan\n    ⇒ TransformBeziers (M) → RasterizeParallel\n',
    'Expand : CoverageSpan >> CoveragePoint\n    ⇒ ExpandSpans\n',
  ]));
  const W = 320, H = 48;
  const params = textSpansParams({ size: 16, width: W, height: H, margin: 4 });
  const beziers = textBeziers(library.api, 'ANY PIPELINE', params);
  const flat = new Float32Array(beziers.flat());
  return { library, nile: library.api, W, H, beziers, flat, n: beziers.length };
});

// The reference for ExpandSpans: a span (x, y, c, l) painted by a loop, as
// the presenter's sink did before ExpandSpans ran on the GPU in Nile.
const spanSink: Sink = {
  bindings: [{ name: 'COV', role: 'sink', access: 'read_write', type: 'array<f32>' }],
  emit: (vals, ind) => [
    `${ind}{`,
    `${ind}  let sx = i32(floor(${vals[0]}));`,
    `${ind}  let sy = i32(floor(${vals[1]}));`,
    `${ind}  let sl = i32(round(${vals[3]}));`,
    `${ind}  for (var si = 0; si < sl; si += 1) {`,
    `${ind}    let px = sx + si;`,
    `${ind}    if (px >= 0 && px < i32(META.minor) && sy >= 0 && sy < i32(META.major)) {`,
    `${ind}      let ci = u32(sy) * META.minor + u32(px);`,
    `${ind}      COV[ci] = min(COV[ci] + ${vals[2]}, 1.0);`,
    `${ind}    }`,
    `${ind}  }`,
    `${ind}}`,
  ].join('\n'),
};
const spanPlan = (name: string): Plan => {
  const { library, W, H } = lowering();
  return lowerPipeline(fusedPipeline(library.ir, name), { extent: [H, W], sink: spanSink });
};
const coverage = (data: ArrayLike<number>): Result => ({ kind: 'coverage', data });
const tokens = (rows: number[][]): Result => ({ kind: 'tokens', rows });
const drew = { min: 100 };

async function renderCoverage(device: GPUDevice, plan: Plan, flat: Float32Array<ArrayBuffer>, n: number, params: number[] = [], what = ''): Promise<Result> {
  const { createCoverageReadback } = await readback();
  const gpu = createCoverageReadback(device, plan, params);
  try {
    const cov = await gpu.render(flat, n);
    if (gpu.overflowed()) throw new Error(`${what}: worklist overflow`);
    return coverage(cov);
  } finally {
    gpu.dispose();
  }
}

const pixelsOnGpu = (device: GPUDevice) => {
  const { library, W, H, flat, n } = lowering();
  return renderCoverage(device, coveragePlan(library.ir, 'RasterizePixels', W, H), flat, n, [], 'RasterizePixels');
};

export const loweringScenarios: Scenario[] = [
  {
    what: 'RasterizePixels vs the span loop, both on the GPU',
    reference: (device) => renderCoverage(device, spanPlan('RasterizeParallel'), lowering().flat, lowering().n),
    gpu: pixelsOnGpu,
    compare: compareCoverage(0, drew),
  },
  {
    what: 'RasterizePixels vs the CPU',
    cpu: () => {
      const { nile, beziers, W, H } = lowering();
      return coverage(paintCoverage(nile.RasterizeParallel().run(beziers), W, H));
    },
    gpu: pixelsOnGpu,
    // f32 vs f64: a sample on a pixel boundary can land one cell over.
    compare: compareCoverage(0.2, drew),
  },
  {
    what: 'RasterizeMapped (TransformBeziers (M) fused ahead, M from P) vs the CPU',
    cpu: () => {
      const { nile, beziers, W, H } = lowering();
      return coverage(paintCoverage(nile.RasterizeMapped({ M: [0.5, 0, 0, 0.5, 40, 10] }).run(beziers), W, H));
    },
    gpu: (device) => {
      // RasterizeMapped emits spans, so its sink is the span loop; the matrix
      // is a pipeline parameter the GPU reads from P.
      const plan = spanPlan('RasterizeMapped');
      if (!plan.passes[0].bindings.some((b) => b.role === 'params')) throw new Error('RasterizeMapped: no params binding');
      return renderCoverage(device, plan, lowering().flat, lowering().n, [0.5, 0, 0, 0.5, 40, 10]);
    },
    compare: compareCoverage(0.2, drew),
  },
  {
    what: 'Expand (ExpandSpans alone, appended)',
    cpu: () => {
      const { nile, beziers } = lowering();
      return tokens(nile.Expand().run(nile.RasterizeParallel().run(beziers)));
    },
    gpu: async (device) => {
      const { readAppended } = await readback();
      const { library, nile, beziers } = lowering();
      const spans = nile.RasterizeParallel().run(beziers);
      const plan = lowerPipeline(fusedPipeline(library.ir, 'Expand'), { extent: [1], sink: appendSink(4) });
      return tokens(await readAppended(device, plan, spans, 4, nile.Expand().run(spans).length + 1024));
    },
    compare: compareMultiset((t) => `${t[0]},${t[1]},${Math.fround(t[2]).toFixed(5)}`),
  },
];

// The samples' own Nile against the CPU: the pipelines the Cairo samples
// page added that the lowering accepts by their declarations, none of which
// it was written against.
//
//   RasterizePixelsEvenOdd   the even-odd rule: the same grid as the winding
//                            rasterizer, a different kernel after the scan
//   Intersect                the clip join: a join of two pixel streams by
//                            + alone (sum and sum of squares), appended
//   MeshPixels               a Coons patch: 49-wide tokens, five reduced
//                            fields, coloured pixels appended
const samples = once(() => {
  const library = compiled(compileLibraryFile('demos/nl/samples.nl-lib'));
  return { library, nile: library.api, W: 64, H: 64 };
});

// A square wound twice: under the even-odd rule, a ring of about 1600 pixels.
const twice = () => [...square(4, 4, 54, 54), ...square(14, 14, 44, 44)];
// Two overlapping squares' spans: the product of coverages where both are.
const overlapping = () => {
  const { nile } = samples();
  return [...nile.RasterizeParallel().run(square(2, 2, 40, 40)), ...nile.RasterizeParallel().run(square(20.5, 20.5, 60, 60))];
};
// One patch with straight sides, 49-wide tokens, five fields reduced.
const patch = () => {
  const { Patch } = samples().nile.types;
  return Patch.make({ T: lineCubic([8, 8], [40, 10]), B: lineCubic([10, 44], [42, 40]), L: lineCubic([8, 8], [10, 44]), R: lineCubic([40, 10], [42, 40]), C00: [1, 1, 0, 0], C10: [1, 0, 1, 0], C01: [1, 0, 0, 1], C11: [1, 1, 1, 1], d: 0 });
};
// PaintedPixel is (C : Color, P : CoveragePoint): the pixel is at 4, 5.
const atPixel = (ts: number[][]) => ts.map((t) => [t[4], t[5], t[0], t[1], t[2], t[3], t[6]]);

async function appended(device: GPUDevice, name: string, input: number[][], width: number, cap: number): Promise<number[][]> {
  const { readAppended } = await readback();
  const { library, W, H } = samples();
  const plan = lowerPipeline(fusedPipeline(library.ir, name), { extent: [H, W], sink: appendSink(width) });
  return readAppended(device, plan, input, width, cap);
}

export const sampleScenarios: Scenario[] = [
  {
    what: 'RasterizePixelsEvenOdd (a ring) vs the CPU',
    cpu: () => {
      const { nile, W, H } = samples();
      return coverage(paintCoverage(nile.RasterizeEvenOdd().run(twice()), W, H));
    },
    gpu: (device) => {
      const { library, W, H } = samples();
      const shape = twice();
      return renderCoverage(device, coveragePlan(library.ir, 'RasterizePixelsEvenOdd', W, H), new Float32Array(shape.flat()), shape.length, [], 'RasterizePixelsEvenOdd');
    },
    compare: compareCoverage(0.2, { min: 1000, max: 2000 }),
  },
  {
    what: 'Intersect (the join by + alone) vs the CPU',
    cpu: () => tokens(samples().nile.Intersect().run(overlapping())),
    gpu: async (device) => {
      const both = overlapping();
      return tokens(await appended(device, 'Intersect', both, 4, samples().nile.Intersect().run(both).length + 1024));
    },
    compare: comparePixels([2, 3], 1e-3),
  },
  {
    // The sums' order differs, and the grid holds 16.16 fixed point, so
    // colours agree to a tolerance.
    what: 'MeshPixels (a Coons patch, summed per pixel) vs the CPU',
    cpu: () => tokens(atPixel(samples().nile.MeshPixels().run([patch()]))),
    gpu: async (device) => {
      const p = patch();
      return tokens(atPixel(await appended(device, 'MeshPixels', [p], 8, samples().nile.MeshPixels().run([p]).length + 1024)));
    },
    compare: comparePixels([2, 3, 4, 5, 6], 0.02),
  },
];

export const scenarios: Scenario[] = [...loweringScenarios, ...sampleScenarios];
