// Textures on the GPU, verified headless: each paint preset whose texture is
// made of map kernels is lowered to a WGSL paint() function and composited
// by the GPU rasterizer; the image is compared with the CPU (JS, f64) paint
// of the same shapes. Filter presets must be refused with a reason.
//
// Run: deno run --allow-read --unstable-sloppy-imports tools/check-paint-gpu.ts

import { read } from '../src/sources.js';
import { compileLibrary } from '../../umgeni/src/compile.js';
import { createPresenter } from '../../umgeni/src/gpu/present.js';
import { lowerPipeline } from '../../umgeni/src/gpu/lower.js';
import { coverageSink } from '../../umgeni/src/gpu/execute.js';
import { lowerTexture } from '../../umgeni/src/gpu/texture.js';
import { requestDevice } from '../../umgeni/src/gpu/runtime.js';
import { PAINT_GLUE, paintShapes } from '../src/vector/paint.js';
import { writePixels } from '../src/vector/spans.js';
import { PRESETS } from '../paint-presets.js';

const gezira = ['types', 'bezier', 'stroke', 'rasterize', 'texture', 'compositor', 'gradient', 'filter']
  .map((n) => read(`gezira/${n}.nl`))
  .concat(read('demos/nl/vector.nl'), read('demos/nl/spans.nl'), read('umgeni/nl/rasterize-parallel.nl'));

const W = 480;
const H = 360;
const device = (await requestDevice())!;
let failures = 0;

for (const preset of PRESETS) {
  const library = compileLibrary([...gezira, preset.source, PAINT_GLUE]);
  if (library.unsupported.length > 0) throw new Error(`${preset.name}: ${JSON.stringify(library.unsupported)}`);
  const tex = lowerTexture(library.ir, 'Paint');
  if (!tex.ok) {
    console.log(`${preset.name}: CPU only — ${tex.reason}`);
    continue;
  }
  const shapes = paintShapes(library.api, W, H);

  // CPU reference: the same beziers, rasterized and painted in JS.
  const cpu = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) };
  for (const bs of shapes) writePixels(cpu, library.api, library.api.PaintBeziers({ min: [0, 0], max: [W, H] }).run(bs));

  // GPU: RasterizeParallel lowered from source, composite with the lowered paint().
  const fused = library.ir.processes.find((p) => p.k === 'fused' && p.name === 'RasterizePixels');
  if (!fused || fused.k !== 'fused') throw new Error('RasterizePixels not fused');
  const gpu = createPresenter(device, lowerPipeline(fused, { extent: [H, W], sink: coverageSink }), { format: 'rgba8unorm', paint: tex.wgsl });
  const target = device.createTexture({
    size: { width: W, height: H }, format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  device.pushErrorScope('validation');
  gpu.frame(shapes.map((bs) => ({ tokens: new Float32Array(bs.flat()), n: bs.length, color: [0, 0, 0] as const })), target.createView());
  const err = await device.popErrorScope();
  if (err) throw new Error(`${preset.name}: GPU validation error: ${err.message}`);

  const rowBytes = Math.ceil((W * 4) / 256) * 256;
  const buf = device.createBuffer({ size: rowBytes * H, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: rowBytes }, { width: W, height: H });
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const px = new Uint8Array(buf.getMappedRange().slice(0));
  buf.unmap();

  let sum = 0;
  let big = 0;
  let painted = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const g = y * rowBytes + x * 4;
      const c = (y * W + x) * 4;
      let d = 0;
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(px[g + k] - cpu.data[c + k]));
      sum += d;
      if (d > 48) big++;
      if (cpu.data[c] !== 255 || cpu.data[c + 1] !== 255 || cpu.data[c + 2] !== 255) painted++;
    }
  }
  const mean = sum / (W * H);
  const ok = painted > W * H * 0.2 && mean < 2 && big < W * H * 0.005;
  if (!ok) failures++;
  console.log(
    `${preset.name}: GPU ${ok ? 'ok' : 'MISMATCH'} — mean channel diff ${mean.toFixed(3)}, ` +
    `${big} px >48 (antialiased edges, f32 vs f64), ${painted} painted px, paint() ${tex.wgsl.split('\n').length} lines of WGSL`,
  );
}
if (failures > 0) throw new Error(`${failures} preset(s) differ`);
console.log('paint GPU ok');
