// The GPU lowering is a compiler, not a template: pipelines it has never
// seen lower from their declarations and agree with the CPU. Three shapes
// beyond RasterizeParallel, each against the same Nile run by the JS backend:
//
//   RasterizePixels   a feedback kernel (ExpandSpans) after the window, and a
//                     per-pixel sink in place of the span loop
//   RasterizeMapped   a parameterized map kernel (TransformBeziers (M)) fused
//                     ahead of the worklist pass
//   Expand            ExpandSpans alone, one pass, output appended to a buffer
//
// Run: deno run --allow-read --allow-env --unstable-sloppy-imports demos/tools/check-lowering.ts

import { read } from '../src/sources.js';
import { compileProgram } from '../../umgeni/src/compile.js';
import { createRasterHost } from '../../umgeni/src/gpu/raster.js';
import { lowerPipeline } from '../../umgeni/src/gpu/lower.js';
import { appendSink, coverageSink, createExecutor, metaWords, wholeGrid } from '../../umgeni/src/gpu/execute.js';
import { requestDevice } from '../../umgeni/src/gpu/runtime.js';
import { META_BYTES, type Sink } from '../../umgeni/src/gpu/lower.js';

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
import { paintCoverage, textSpansParams, textTokens } from '../src/text/host.js';

const program = compileProgram([
  read('gezira/types.nl'),
  read('gezira/bezier.nl'),
  read('gezira/rasterize.nl'),
  read('gezira/texture.nl'),
  read('demos/nl/text.nl'),
  read('umgeni/nl/rasterize-parallel.nl'),
  // Two pipelines the lowering has not been written against.
  'RasterizeMapped (M : Matrix) : Bezier >> CoverageSpan\n    ⇒ TransformBeziers (M) → RasterizeParallel\n',
  'Expand : CoverageSpan >> CoveragePoint\n    ⇒ ExpandSpans\n',
]);
if (program.unsupported.length > 0) throw new Error(JSON.stringify(program.unsupported));
const fused = (name: string) => {
  const f = program.ir.processes.find((p) => p.k === 'fused' && p.name === name);
  if (!f || f.k !== 'fused') throw new Error(`${name} not fused`);
  return f;
};
const nile = program.api;

const W = 320;
const H = 48;
const params = textSpansParams({ size: 16, width: W, height: H, margin: 4 });
const beziers = nile.TextBeziers(params).run(textTokens(nile, 'ANY PIPELINE'));
const flat = new Float32Array(beziers.flat());
const n = beziers.length;
const device = (await requestDevice())!;

function compare(what: string, cpu: ArrayLike<number>, gpu: ArrayLike<number>, tolerance: number): void {
  let max = 0;
  let covered = 0;
  for (let i = 0; i < cpu.length; i++) {
    max = Math.max(max, Math.abs(cpu[i] - gpu[i]));
    if (cpu[i] > 0.5) covered++;
  }
  if (covered < 100) throw new Error(`${what}: too few covered pixels (${covered})`);
  if (max > tolerance) throw new Error(`${what}: CPU and GPU disagree, max ${max.toFixed(4)} > ${tolerance}`);
  console.log(`${what}: ok, ${covered} px covered, max diff ${max.toFixed(4)}`);
}

// 1. RasterizePixels: pixels from the GPU vs the CPU's spans expanded, and
// vs the GPU's own spans painted by the hand-written loop (spanSink), which
// the Nile ExpandSpans must reproduce exactly.
{
  const pixels = createRasterHost(device, lowerPipeline(fused('RasterizePixels'), { extent: [H, W], sink: coverageSink }));
  const spans = createRasterHost(device, lowerPipeline(fused('RasterizeParallel'), { extent: [H, W], sink: spanSink }));
  const cov = await pixels.render(flat, n);
  if (pixels.overflowed()) throw new Error('RasterizePixels: worklist overflow');
  compare('RasterizePixels vs the span loop, both on the GPU', await spans.render(flat, n), cov, 0);
  // f32 vs f64: a sample on a pixel boundary can land one cell over.
  compare('RasterizePixels vs the CPU', paintCoverage(nile.RasterizeParallel().run(beziers), W, H), cov, 0.2);
  pixels.dispose();
  spans.dispose();
}

// 2. RasterizeMapped: the matrix is a pipeline parameter the GPU reads from P.
{
  const M = [0.5, 0, 0, 0.5, 40, 10];
  // RasterizeMapped emits spans, so its sink is the span loop.
  const plan = lowerPipeline(fused('RasterizeMapped'), { extent: [H, W], sink: spanSink });
  if (!plan.passes[0].bindings.some((b) => b.role === 'params')) throw new Error('RasterizeMapped: no params binding');
  const gpu = createRasterHost(device, plan, M);
  const cov = await gpu.render(flat, n);
  compare('RasterizeMapped (TransformBeziers (M) fused ahead, M from P) vs the CPU', paintCoverage(nile.RasterizeMapped({ M }).run(beziers), W, H), cov, 0.2);
  gpu.dispose();
}

// 3. Expand: one pass, tokens appended; the CPU's output as a multiset.
{
  const spans = nile.RasterizeParallel().run(beziers);
  const cpu = nile.Expand().run(spans);
  const plan = lowerPipeline(fused('Expand'), { extent: [1], sink: appendSink(4) });
  const x = createExecutor(device, plan);
  const cap = cpu.length + 1024;
  const meta = device.createBuffer({ size: META_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const input = device.createBuffer({ size: spans.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const out = device.createBuffer({ size: cap * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const count = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const readBuf = device.createBuffer({ size: cap * 16 + 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(meta, 0, metaWords(spans.length, plan.extent, wholeGrid(plan.extent)));
  device.queue.writeBuffer(input, 0, new Float32Array(spans.flat()));
  const groups = x.bind({ meta, input, sink: { OUT: out, COUNT: count } });
  const enc = device.createCommandEncoder();
  enc.clearBuffer(count);
  x.encode(enc, groups, { n: spans.length, segments: 1 });
  enc.copyBufferToBuffer(out, 0, readBuf, 0, cap * 16);
  enc.copyBufferToBuffer(count, 0, readBuf, cap * 16, 4);
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const mapped = readBuf.getMappedRange();
  const got = new Uint32Array(mapped.slice(cap * 16, cap * 16 + 4))[0];
  const vals = new Float32Array(mapped.slice(0, got * 16));
  readBuf.unmap();
  if (got !== cpu.length) throw new Error(`Expand: GPU emitted ${got} tokens, CPU ${cpu.length}`);
  // Order is unspecified (threads finish as they finish): compare as sorted lists.
  const key = (t: ArrayLike<number>) => `${t[0]},${t[1]},${Math.fround(t[2]).toFixed(5)}`;
  const a = cpu.map(key).sort();
  const b = Array.from({ length: got }, (_, i) => key(vals.subarray(i * 4, i * 4 + 4))).sort();
  const differ = a.filter((k, i) => k !== b[i]).length;
  if (differ > 0) throw new Error(`Expand: ${differ} of ${got} tokens differ`);
  console.log(`Expand (ExpandSpans alone, appended): ok, ${got} tokens, same multiset as the CPU`);
}
console.log('lowering ok');
