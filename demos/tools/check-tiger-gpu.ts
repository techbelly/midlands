// The tiger on the GPU, verified headless: CPU front half per path
// (compiled Nile), then the multi-path GPU rasterizer+compositor into an
// offscreen texture (one submission, zero fences in frame()); readback is
// test-only. Compared against the all-CPU drawTiger image and timed.
//
// Run: deno run --allow-read --unstable-sloppy-imports tools/check-tiger-gpu.ts [size] [zoom]
// (zoom > 1 magnifies about the centre, as the demo's double-click does)

import { compileProgramFile, read } from '../src/sources.js';
import { createPresenter } from '../../umgeni/src/gpu/present.js';
import { lowerFusedPipeline } from '../../umgeni/src/gpu/lower.js';
import { requestDevice } from '../../umgeni/src/gpu/runtime.js';
import * as rt from '../../umgeni/src/cpu/runtime.js';
import { parseSvg } from '../src/vector/svg.js';
import { drawTiger, fitView, paintPaths, tigerPaths, toBatches } from '../src/vector/tiger.js';


const vector = compileProgramFile('demos/nl/vector.program');
const tiger = parseSvg(read('demos/tiger.svg'), vector.api);

const W = Number(Deno.args[0] ?? 512);
const H = W;
const zoom = Number(Deno.args[1] ?? 1);
const fit = fitView(W, H);
const view = fit.map((v, i) => (i < 4 ? v * zoom : v * zoom + (1 - zoom) * (i === 4 ? W : H) / 2));

// CPU end-to-end image (f64 throughout) — the informational comparison.
const cpuImg = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) };
let t0 = performance.now();
drawTiger(cpuImg, tiger, view, vector.api);
const cpuMs = performance.now() - t0;

// GPU: front half on CPU, then one zero-fence submission.
const device = (await requestDevice())!;
const fused = vector.ir.processes.find((p) => p.k === 'fused' && p.name === 'RasterizeParallel');
if (!fused || fused.k !== 'fused') throw new Error('RasterizeParallel not fused');
const shaders = lowerFusedPipeline(fused, { width: W, height: H });
const gpu = createPresenter(device, shaders, { width: W, height: H, format: 'rgba8unorm' });
const tex = device.createTexture({
  size: { width: W, height: H },
  format: 'rgba8unorm',
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});

t0 = performance.now();
const batches = toBatches(tigerPaths(tiger, view, vector.api, W, H));
const frontMs = performance.now() - t0;
device.pushErrorScope('validation');
t0 = performance.now();
gpu.frame(batches, tex.createView());
const submitMs = performance.now() - t0;
t0 = performance.now();
await device.queue.onSubmittedWorkDone(); // timing only; not part of frame()
const gpuMs = performance.now() - t0;
const validation = await device.popErrorScope();
if (validation) throw new Error(`GPU validation error (the frame was dropped): ${validation.message}`);
// Warm frame (buffers allocated, pipelines hot).
t0 = performance.now();
gpu.frame(batches, tex.createView());
const warmSubmitMs = performance.now() - t0;
t0 = performance.now();
await device.queue.onSubmittedWorkDone();
const warmGpuMs = performance.now() - t0;

// The like-for-like CPU reference: the SAME f32 batches through the CPU back
// end (the same RasterizeParallel the GPU lowers), composited with the same
// colors. This isolates GPU raster+composite correctness from f32-vs-f64
// front-half precision (which only shifts antialiased edge pixels).
const refImg = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) };
paintPaths(refImg, vector.api, batches.map((b) => ({
  beziers: Array.from({ length: b.n }, (_, i) => [...b.beziers.slice(i * 6, i * 6 + 6)]),
  color: [b.color[0] * 255, b.color[1] * 255, b.color[2] * 255] as const,
})));

// Test-only readback of the composited texture.
const rowBytes = Math.ceil((W * 4) / 256) * 256;
const readBuf = device.createBuffer({ size: rowBytes * H, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
const enc = device.createCommandEncoder();
enc.copyTextureToBuffer({ texture: tex }, { buffer: readBuf, bytesPerRow: rowBytes }, { width: W, height: H });
device.queue.submit([enc.finish()]);
await readBuf.mapAsync(GPUMapMode.READ);
const px = new Uint8Array(readBuf.getMappedRange().slice(0));
readBuf.unmap();

function compareTo(ref: Uint8ClampedArray): { colored: number; max: number; differ: number } {
  let colored = 0;
  let max = 0;
  let differ = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gi = y * rowBytes + x * 4;
      const ci = (y * W + x) * 4;
      let d = 0;
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(px[gi + k] - ref[ci + k]));
      max = Math.max(max, d);
      if (d > 0) differ++;
      if (px[gi] !== 255 || px[gi + 1] !== 255 || px[gi + 2] !== 255) colored++;
    }
  }
  return { colored, max, differ };
}

const likeForLike = compareTo(refImg.data);
const vsF64 = compareTo(cpuImg.data);
console.log(
  `tiger GPU ${W}x${H} @${zoom}x: ${batches.length} batches · front (CPU Nile) ${frontMs.toFixed(0)} ms · ` +
  `cold submit ${submitMs.toFixed(1)} / GPU ${gpuMs.toFixed(1)} ms · ` +
  `warm submit ${warmSubmitMs.toFixed(1)} / GPU ${warmGpuMs.toFixed(1)} ms · CPU end-to-end ${cpuMs.toFixed(0)} ms`,
);
console.log(
  `like-for-like (same f32 geometry): ${likeForLike.differ} px differ, max channel diff ${likeForLike.max} ` +
  `(f32 vs f64 coverage arithmetic, over ${batches.length} composites) · ` +
  `vs f64 CPU geometry (informational): ${vsF64.differ} px, max ${vsF64.max}`,
);
if (likeForLike.colored < W * H * 0.3) throw new Error('too few colored pixels — tiger missing?');
if (likeForLike.max > 8) throw new Error(`GPU and CPU disagree: max channel diff ${likeForLike.max} (${likeForLike.differ} px)`);
console.log('tiger GPU ok');
