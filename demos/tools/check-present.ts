// Verifies zero-fence presentation headlessly (the tiger compositor with one
// black path): render text through the
// source-lowered pipeline into an offscreen texture, read the texture back
// (a fence, but only in this check — the browser path has none), and compare
// against the compute-only rasterizer's coverage.
//
// Run: deno run --allow-read --unstable-sloppy-imports tools/check-present.ts

import { read } from '../src/sources.js';
import { compileLibrary } from '../../umgeni/src/compile.js';
import { createRasterHost } from '../../umgeni/src/gpu/raster.js';
import { createPresenter } from '../../umgeni/src/gpu/present.js';
import { lowerPipeline } from '../../umgeni/src/gpu/lower.js';
import { coverageSink } from '../../umgeni/src/gpu/execute.js';
import { requestDevice } from '../../umgeni/src/gpu/runtime.js';
import * as rt from '../../umgeni/src/cpu/runtime.js';
import { textSpansParams, textTokens } from '../src/text/host.js';

const library = compileLibrary([
  read('gezira/types.nl'),
  read('gezira/bezier.nl'),
  read('gezira/rasterize.nl'),
  read('gezira/texture.nl'),
  read('demos/nl/text.nl'),
  read('umgeni/nl/rasterize-parallel.nl'),
]);

const W = 320;
const H = 48;
const params = textSpansParams({ size: 16, width: W, height: H, margin: 4 });
const front = library.api.TextBeziers(params);
const bez: number[] = [];
front.setEmit((t) => bez.push(...t));
for (const t of textTokens(library.api, 'ZERO FENCES')) front.push(t);
front.end();
const beziers = new Float32Array(bez);
const n = beziers.length / 6;

const device = (await requestDevice())!;
const fused = library.ir.processes.find((p) => p.k === 'fused' && p.name === 'RasterizePixels');
if (!fused || fused.k !== 'fused') throw new Error('RasterizePixels not fused');
const plan = lowerPipeline(fused, { extent: [H, W], sink: coverageSink });

// Reference: compute-only coverage (one fence).
const raster = createRasterHost(device, plan);
const cov = await raster.render(beziers, n);

// Presenter into an offscreen texture (no fence in frame()).
const tex = device.createTexture({
  size: { width: W, height: H },
  format: 'rgba8unorm',
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});
// The compositor with one black path over white: pixel = 1 − coverage.
const presenter = createPresenter(device, plan, { format: 'rgba8unorm' });
const black = [0, 0, 0] as const;
const t0 = performance.now();
presenter.frame([{ tokens: beziers, n, color: black }], tex.createView());
const submitMs = performance.now() - t0;

// Test-only readback of the texture (bytesPerRow must be 256-aligned).
const rowBytes = Math.ceil((W * 4) / 256) * 256;
const readBuf = device.createBuffer({ size: rowBytes * H, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
const enc = device.createCommandEncoder();
enc.copyTextureToBuffer({ texture: tex }, { buffer: readBuf, bytesPerRow: rowBytes }, { width: W, height: H });
device.queue.submit([enc.finish()]);
await readBuf.mapAsync(GPUMapMode.READ);
const px = new Uint8Array(readBuf.getMappedRange().slice(0));
readBuf.unmap();

let maxErr = 0;
let dark = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const v = px[y * rowBytes + x * 4]; // R channel
    const expected = Math.round(255 * (1 - Math.min(1, cov[y * W + x])));
    maxErr = Math.max(maxErr, Math.abs(v - expected));
    if (v < 128) dark++;
  }
}
if (maxErr > 2) throw new Error(`presented pixels diverge from coverage: max channel error ${maxErr}`);
if (dark < 200) throw new Error(`too few dark pixels (${dark}) — did the text render?`);
console.log(
  `presenter ok: 'ZERO FENCES' at ${W}x${H}, ${n} beziers, ${dark} dark px, ` +
  `max channel err ${maxErr}, frame() submit ${submitMs.toFixed(2)} ms, fences in frame(): 0`,
);

// Regression: a second, shorter frame must not ghost the first (the lowered
// resolve accumulates into coverage, so the core must clear it per frame).
{
  const bez2: number[] = [];
  const front2 = library.api.TextBeziers(params);
  front2.setEmit((t) => bez2.push(...t));
  for (const t of textTokens(library.api, 'ZERO')) front2.push(t);
  front2.end();
  const beziers2 = new Float32Array(bez2);
  presenter.frame([{ tokens: beziers2, n: beziers2.length / 6, color: black }], tex.createView());

  const enc2 = device.createCommandEncoder();
  enc2.copyTextureToBuffer({ texture: tex }, { buffer: readBuf, bytesPerRow: rowBytes }, { width: W, height: H });
  device.queue.submit([enc2.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const px2 = new Uint8Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();
  // Pixels in the right half (where 'FENCES' was) must be back to white.
  let stale = 0;
  for (let y = 0; y < H; y++) {
    for (let x = Math.floor(W / 2); x < W; x++) {
      if (px2[y * rowBytes + x * 4] < 250) stale++;
    }
  }
  if (stale > 0) throw new Error(`ghosting: ${stale} stale pixels survived the second frame`);
  console.log(`no ghosting: second frame ('ZERO') left ${stale} stale pixels from frame one`);
}

// Regression: scaling DOWN must not ghost either. A smaller size draws fewer
// rows; each path clears and resolves only its own row band, so nothing may
// read (or draw) coverage outside that band — rows the previous, larger
// frame covered must come back white.
{
  const small = textSpansParams({ size: 8, width: W, height: H, margin: 4 });
  const bez3: number[] = [];
  const front3 = library.api.TextBeziers(small);
  front3.setEmit((t) => bez3.push(...t));
  for (const t of textTokens(library.api, 'ZERO FENCES')) front3.push(t);
  front3.end();
  const beziers3 = new Float32Array(bez3);
  let maxY = 0;
  for (let i = 1; i < beziers3.length; i += 2) maxY = Math.max(maxY, beziers3[i]);
  presenter.frame([{ tokens: beziers3, n: beziers3.length / 6, color: black }], tex.createView());

  const enc3 = device.createCommandEncoder();
  enc3.copyTextureToBuffer({ texture: tex }, { buffer: readBuf, bytesPerRow: rowBytes }, { width: W, height: H });
  device.queue.submit([enc3.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const px3 = new Uint8Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();
  let stale = 0;
  for (let y = Math.ceil(maxY) + 2; y < H; y++) {
    for (let x = 0; x < W; x++) if (px3[y * rowBytes + x * 4] < 250) stale++;
  }
  if (stale > 0) throw new Error(`ghosting after scaling down: ${stale} stale pixels below the text`);
  console.log(`no ghosting after scaling down: ${stale} stale pixels below row ${Math.ceil(maxY) + 2}`);
}
