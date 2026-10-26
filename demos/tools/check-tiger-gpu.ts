// The tiger on the GPU, verified headless: CPU front half per path
// (compiled Nile), then the multi-path GPU rasterizer+compositor into an
// offscreen texture (one submission, zero fences in frame()); readback is
// test-only. Compared against the all-CPU drawTiger image and timed.
//
// Run: npm run check:tiger [-- size zoom]  (deno, with WebGPU)
// (zoom > 1 magnifies about the centre, as the demo's double-click does)

import { compileLibraryFile, read } from '../src/sources.js';
import { createPresenter } from '../../umgeni/src/gpu/present.js';
import { parseSvg } from '../src/vector/svg.js';
import { blankImage } from '../src/vector/spans.js';
import { drawTiger, fitView, paintPaths, tigerPaths, toBatches } from '../src/vector/tiger.js';
import { coveragePlan, imageDiff, offscreenTexture, readTexture, requireDevice } from './gpu-check.js';

const vector = compileLibraryFile('demos/nl/vector.nl-lib');
const tiger = parseSvg(read('demos/tiger.svg'), vector.api);

const W = Number(Deno.args[0] ?? 512);
const H = W;
const zoom = Number(Deno.args[1] ?? 1);
const fit = fitView(W, H);
const view = fit.map((v, i) => (i < 4 ? v * zoom : v * zoom + (1 - zoom) * (i === 4 ? W : H) / 2));

// CPU end-to-end image (f64 throughout) — the informational comparison.
const cpuImg = blankImage(W, H);
let t0 = performance.now();
drawTiger(cpuImg, tiger, view, vector.api);
const cpuMs = performance.now() - t0;

// GPU: front half on CPU, then one zero-fence submission.
const device = await requireDevice();
const gpu = createPresenter(device, coveragePlan(vector.ir, 'RasterizePixels', W, H), { format: 'rgba8unorm' });
const tex = offscreenTexture(device, W, H);

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
const refImg = blankImage(W, H);
paintPaths(refImg, vector.api, batches.map((b) => ({
  beziers: Array.from({ length: b.n }, (_, i) => [...b.tokens.slice(i * 6, i * 6 + 6)]),
  color: [b.color[0], b.color[1], b.color[2]] as const,
})));

const px = await readTexture(device, tex, W, H);
const likeForLike = imageDiff(px, refImg.data);
const vsF64 = imageDiff(px, cpuImg.data);
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
if (likeForLike.inked.gpu < W * H * 0.3) throw new Error('too few colored pixels — tiger missing?');
if (likeForLike.max > 8) throw new Error(`GPU and CPU disagree: max channel diff ${likeForLike.max} (${likeForLike.differ} px)`);
console.log('tiger GPU ok');
