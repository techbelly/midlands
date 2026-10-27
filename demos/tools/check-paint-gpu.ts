// Textures on the GPU, verified headless: each paint preset whose texture is
// made of map kernels is lowered to a WGSL paint() function and composited
// by the GPU rasterizer; the image is compared with the CPU (JS, f64) paint
// of the same shapes. Filter presets must be refused with a reason.
//
// Run: npm run check:paint  (deno, with WebGPU)

import { librarySourceTexts } from '../src/sources.js';
import { compileLibrary } from '../../umgeni/src/compile.js';
import { createPresenter, pathBatch } from '../../umgeni/src/gpu/present.js';
import { lowerTexture } from '../../umgeni/src/gpu/texture.js';
import { PAINT_GLUE, paintShapes } from '../src/vector/paint.js';
import { blankImage, writePixels } from '../src/vector/spans.js';
import { PRESETS } from '../paint-presets.js';
import { coveragePlan, imageDiff, offscreenTexture, readTexture, requireDevice } from './gpu-check.js';

const paintLibrary = librarySourceTexts('demos/nl/paint.nl-lib');

const W = 480;
const H = 360;
const device = await requireDevice();
let failures = 0;

for (const preset of PRESETS) {
  const library = compileLibrary([...paintLibrary, preset.source, PAINT_GLUE]);
  if (library.unsupported.length > 0) throw new Error(`${preset.name}: ${JSON.stringify(library.unsupported)}`);
  const tex = lowerTexture(library.ir, 'Paint');
  if (!tex.ok) {
    console.log(`${preset.name}: CPU only — ${tex.reason}`);
    continue;
  }
  const shapes = paintShapes(library.api, W, H);

  // CPU reference: the same beziers, rasterized and painted in JS.
  const cpu = blankImage(W, H);
  for (const bs of shapes) writePixels(cpu, library.api, library.api.PaintBeziers({ min: [0, 0], max: [W, H] }).run(bs));

  // GPU: RasterizeParallel lowered from source, composite with the lowered paint().
  const gpu = createPresenter(device, coveragePlan(library.ir, 'RasterizePixels', W, H), { format: 'rgba8unorm', paint: tex.wgsl });
  const target = offscreenTexture(device, W, H);
  device.pushErrorScope('validation');
  gpu.frame(shapes.map((bs) => pathBatch(bs, [0, 0, 0])), target.createView());
  const err = await device.popErrorScope();
  if (err) throw new Error(`${preset.name}: GPU validation error: ${err.message}`);

  const d = imageDiff(await readTexture(device, target, W, H), cpu.data, 48);
  const ok = d.inked.cpu > W * H * 0.2 && d.mean < 2 && d.far < W * H * 0.005;
  if (!ok) failures++;
  console.log(
    `${preset.name}: GPU ${ok ? 'ok' : 'MISMATCH'} — mean channel diff ${d.mean.toFixed(3)}, ` +
    `${d.far} px >48 (antialiased edges, f32 vs f64), ${d.inked.cpu} painted px, paint() ${tex.wgsl.split('\n').length} lines of WGSL`,
  );
}
if (failures > 0) throw new Error(`${failures} preset(s) differ`);
console.log('paint GPU ok');
