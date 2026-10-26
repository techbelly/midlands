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
import { createRasterHost } from '../../umgeni/src/gpu/raster.js';
import { lowerPipeline, META_BYTES, type Plan } from '../../umgeni/src/gpu/lower.js';
import { appendSink, coverageSink, createExecutor, metaWords, wholeGrid } from '../../umgeni/src/gpu/execute.js';
import { requestDevice } from '../../umgeni/src/gpu/device.js';
import { paintCoverage } from '../src/text/host.js';
import type { FusedIR } from '../../umgeni/src/ir.js';

const library = compileLibraryFile('demos/nl/samples.nl-lib');
if (library.unsupported.length > 0) throw new Error(JSON.stringify(library.unsupported));
const nile = library.api;
const fused = (name: string): FusedIR => {
  const f = library.ir.processes.find((p) => p.k === 'fused' && p.name === name);
  if (!f || f.k !== 'fused') throw new Error(`${name} not fused`);
  return f;
};
const device = (await requestDevice())!;
if (!device) throw new Error('no WebGPU device');

// A square as flat beziers, clockwise.
const square = (x0: number, y0: number, x1: number, y1: number): number[][] => {
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return pts.map((p, i) => {
    const q = pts[(i + 1) % 4];
    return [p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, q[0], q[1]];
  });
};

// Run a plan whose sink appends tokens, over the whole grid, and read them back.
async function appended(plan: Plan, tokens: number[][], width: number, cap: number): Promise<number[][]> {
  const x = createExecutor(device, plan);
  const inWidth = plan.inputWidth;
  const meta = device.createBuffer({ size: META_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const input = device.createBuffer({ size: Math.max(16, tokens.length * inWidth * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const out = device.createBuffer({ size: cap * width * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const count = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const readBuf = device.createBuffer({ size: cap * width * 4 + 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(meta, 0, metaWords(tokens.length, plan.extent, wholeGrid(plan.extent)));
  device.queue.writeBuffer(input, 0, new Float32Array(tokens.flat()));
  const groups = x.bind({ meta, input, sink: { OUT: out, COUNT: count } });
  const enc = device.createCommandEncoder();
  x.clearGrids(enc, 0, plan.cells);
  enc.clearBuffer(count);
  enc.clearBuffer(x.overflow);
  x.encode(enc, groups, { n: tokens.length, segments: plan.extent[0] });
  enc.copyBufferToBuffer(out, 0, readBuf, 0, cap * width * 4);
  enc.copyBufferToBuffer(count, 0, readBuf, cap * width * 4, 4);
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const mapped = readBuf.getMappedRange();
  const got = new Uint32Array(mapped.slice(cap * width * 4, cap * width * 4 + 4))[0];
  const vals = new Float32Array(mapped.slice(0, got * width * 4));
  readBuf.unmap();
  if (got > cap) throw new Error(`${plan.name}: more tokens than the buffer holds`);
  const result: number[][] = [];
  for (let i = 0; i < got; i++) result.push(Array.from(vals.subarray(i * width, i * width + width)));
  for (const b of [meta, input, out, count, readBuf]) b.destroy();
  x.dispose();
  return result;
}

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

// 1. The even-odd rule: a square wound twice is a ring.
{
  const twice = [...square(4, 4, 54, 54), ...square(14, 14, 44, 44)];
  const gpu = createRasterHost(device, lowerPipeline(fused('RasterizePixelsEvenOdd'), { extent: [H, W], sink: coverageSink }));
  const cov = await gpu.render(new Float32Array(twice.flat()), twice.length);
  if (gpu.overflowed()) throw new Error('RasterizePixelsEvenOdd: worklist overflow');
  const cpu = paintCoverage(nile.RasterizeEvenOdd().run(twice), W, H);
  let max = 0, covered = 0;
  for (let i = 0; i < cpu.length; i++) {
    max = Math.max(max, Math.abs(cpu[i] - cov[i]));
    if (cpu[i] > 0.5) covered++;
  }
  if (covered < 1000 || covered > 2000) throw new Error(`RasterizePixelsEvenOdd: ${covered} covered pixels, expected a ring of about 1600`);
  if (max > 0.2) throw new Error(`RasterizePixelsEvenOdd: CPU and GPU disagree, max ${max.toFixed(4)}`);
  console.log(`RasterizePixelsEvenOdd vs the CPU: ok, ${covered} px covered (a ring), max diff ${max.toFixed(4)}`);
  gpu.dispose();
}

// 2. The clip join: two overlapping squares' spans, the product of coverages
// where both are, nothing elsewhere.
{
  const shape = nile.RasterizeParallel().run(square(2, 2, 40, 40));
  const clip = nile.RasterizeParallel().run(square(20.5, 20.5, 60, 60));
  const both = [...shape, ...clip];
  const cpu = nile.Intersect().run(both);
  const plan = lowerPipeline(fused('Intersect'), { extent: [H, W], sink: appendSink(4) });
  const gpu = await appended(plan, both, 4, cpu.length + 1024);
  comparePixels('Intersect (the join by + alone) vs the CPU', cpu, gpu, [2, 3], 1e-3);
}

// 3. A mesh gradient: one patch with straight sides, 49-wide tokens, five
// fields reduced, coloured pixels out. The sums' order differs, and the grid
// holds 16.16 fixed point, so colours agree to a tolerance.
{
  const line = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x0 + (x1 - x0) / 3, y0 + (y1 - y0) / 3, x0 + (2 * (x1 - x0)) / 3, y0 + (2 * (y1 - y0)) / 3, x1, y1];
  const { Patch } = nile.types;
  const patch = Patch.make({ T: line(8, 8, 40, 10), B: line(10, 44, 42, 40), L: line(8, 8, 10, 44), R: line(40, 10, 42, 40), C00: [1, 1, 0, 0], C10: [1, 0, 1, 0], C01: [1, 0, 0, 1], C11: [1, 1, 1, 1], d: 0 });
  const cpu = nile.MeshPixels().run([patch]);
  const plan = lowerPipeline(fused('MeshPixels'), { extent: [H, W], sink: appendSink(8) });
  const gpu = await appended(plan, [patch], 8, cpu.length + 1024);
  // PaintedPixel is (C : Color, P : CoveragePoint): the pixel is at 4, 5.
  const atPixel = (ts: number[][]) => ts.map((t) => [t[4], t[5], t[0], t[1], t[2], t[3], t[6]]);
  comparePixels('MeshPixels (a Coons patch, summed per pixel) vs the CPU', atPixel(cpu), atPixel(gpu), [2, 3, 4, 5, 6], 0.02);
}
console.log('samples ok');
