// The samples' own Nile on a real GPU, against the CPU: the pipelines the
// Cairo samples page added that the lowering accepts by their declarations,
// none of which it was written against.
//
//   RasterizePixelsEvenOdd   the even-odd rule: the same grid as the winding
//                            rasterizer, a different kernel after the scan
//   Intersect                the clip join: a join of two pixel streams by
//                            + alone (sum and sum of squares), appended
//   MeshPixels               a Coons patch: 49-wide tokens, five reduced
//                            fields, coloured pixels appended
//
// Run: npm run check:samples  (deno, with WebGPU)

import { compileLibraryFile } from '../src/sources.js';
import { createRasterHost, readAppended } from '../../umgeni/src/gpu/raster.js';
import { lowerPipeline } from '../../umgeni/src/gpu/lower.js';
import { appendSink } from '../../umgeni/src/gpu/execute.js';
import { fusedPipeline } from '../../umgeni/src/ir.js';
import { paintCoverage } from '../src/text/host.js';
import { compareCoverage, coveragePlan, requireDevice } from './gpu-check.js';
import { square } from '../test/fixtures.js';
import { lineCubic } from '../src/samples/path.js';

const library = compileLibraryFile('demos/nl/samples.nl-lib');
if (library.unsupported.length > 0) throw new Error(JSON.stringify(library.unsupported));
const nile = library.api;
const device = await requireDevice();

// Tokens as a map by pixel, for comparing two streams whose order differs.
const byPixel = (ts: number[][]) => new Map(ts.map((t) => [`${Math.floor(t[0])},${Math.floor(t[1])}`, t]));
function comparePixels(what: string, cpu: number[][], gpu: number[][], fields: number[], tolerance: number): void {
  const a = byPixel(cpu), b = byPixel(gpu);
  if (a.size !== b.size) throw new Error(`${what}: CPU has ${a.size} pixels, GPU ${b.size}`);
  let max = 0;
  for (const [k, t] of a) {
    const u = b.get(k);
    if (!u) throw new Error(`${what}: pixel ${k} is missing on the GPU`);
    for (const f of fields) max = Math.max(max, Math.abs(t[f] - u[f]));
  }
  if (max > tolerance) throw new Error(`${what}: CPU and GPU disagree, max ${max.toFixed(5)} > ${tolerance}`);
  console.log(`${what}: ok, ${a.size} pixels, max diff ${max.toFixed(5)}`);
}

const W = 64, H = 64;

// 1. The even-odd rule: a square wound twice is a ring of about 1600 pixels.
{
  const twice = [...square(4, 4, 54, 54), ...square(14, 14, 44, 44)];
  const gpu = createRasterHost(device, coveragePlan(library.ir, 'RasterizePixelsEvenOdd', W, H));
  const cov = await gpu.render(new Float32Array(twice.flat()), twice.length);
  if (gpu.overflowed()) throw new Error('RasterizePixelsEvenOdd: worklist overflow');
  const cpu = paintCoverage(nile.RasterizeEvenOdd().run(twice), W, H);
  compareCoverage('RasterizePixelsEvenOdd (a ring) vs the CPU', cpu, cov, 0.2, { min: 1000, max: 2000 });
  gpu.dispose();
}

// 2. The clip join: two overlapping squares' spans, the product of coverages
// where both are, nothing elsewhere.
{
  const shape = nile.RasterizeParallel().run(square(2, 2, 40, 40));
  const clip = nile.RasterizeParallel().run(square(20.5, 20.5, 60, 60));
  const both = [...shape, ...clip];
  const cpu = nile.Intersect().run(both);
  const plan = lowerPipeline(fusedPipeline(library.ir, 'Intersect'), { extent: [H, W], sink: appendSink(4) });
  const gpu = await readAppended(device, plan, both, 4, cpu.length + 1024);
  comparePixels('Intersect (the join by + alone) vs the CPU', cpu, gpu, [2, 3], 1e-3);
}

// 3. A mesh gradient: one patch with straight sides, 49-wide tokens, five
// fields reduced, coloured pixels out. The sums' order differs, and the grid
// holds 16.16 fixed point, so colours agree to a tolerance.
{
  const { Patch } = nile.types;
  const patch = Patch.make({ T: lineCubic([8, 8], [40, 10]), B: lineCubic([10, 44], [42, 40]), L: lineCubic([8, 8], [10, 44]), R: lineCubic([40, 10], [42, 40]), C00: [1, 1, 0, 0], C10: [1, 0, 1, 0], C01: [1, 0, 0, 1], C11: [1, 1, 1, 1], d: 0 });
  const cpu = nile.MeshPixels().run([patch]);
  const plan = lowerPipeline(fusedPipeline(library.ir, 'MeshPixels'), { extent: [H, W], sink: appendSink(8) });
  const gpu = await readAppended(device, plan, [patch], 8, cpu.length + 1024);
  // PaintedPixel is (C : Color, P : CoveragePoint): the pixel is at 4, 5.
  const atPixel = (ts: number[][]) => ts.map((t) => [t[4], t[5], t[0], t[1], t[2], t[3], t[6]]);
  comparePixels('MeshPixels (a Coons patch, summed per pixel) vs the CPU', atPixel(cpu), atPixel(gpu), [2, 3, 4, 5, 6], 0.02);
}
console.log('samples ok');
