// The web demo shell: DOM in, pixels out. The pipeline itself is
// pipeline.gen.js — the Umgeni compiler's generated JS plus Rasterize2 as
// fused IR (plain data), produced at build time by tools/build-demo.mjs.
//
// Three rendering paths over the same Nile source:
//   cpu  — the compiled JS pipeline: layout, then each colour run (colour
//          emoji are stacks of coloured layers) transformed, clipped,
//          rasterized and composited in order.
//   gpu  — layout/transform/clip on CPU, then the GPU pipeline LOWERED IN
//          THE BROWSER from the shipped IR; coverage read back (one fence)
//          and painted via 2D canvas (one colour).
//   gpu0 — the colour runs rasterized and composited on the GPU in one
//          submission to a WebGPU canvas: zero fences per frame.

import * as rt from '../umgeni/src/cpu/runtime.js';
import { colorRuns, fallback, paintCoverage, textSpansParams, textTokens, type ColorRun, type GlyphSource } from './src/text/host.js';
import { glyphFor as stubGlyph } from './src/text/stubfont.js';
import { parseTrueType } from './src/text/ttf.js';
import { collectSpans } from './src/vector/draw.js';
import { paintSpans } from './src/vector/spans.js';
// Source Serif 4: SIL OFL 1.1 (fonts/OFL.txt)
import sourceSerif from './fonts/SourceSerif4.ttf';
// Twemoji Mozilla: CC-BY 4.0 art (fonts/TWEMOJI-LICENSE.md)
import twemoji from './fonts/Twemoji.Mozilla.ttf';
import { createRasterHost, type GpuRasterizer } from '../umgeni/src/gpu/raster.js';
import { createTigerGpu, type TigerGpu } from '../umgeni/src/gpu/tiger.js';
import { lowerFusedPipeline, type LoweredShaders } from '../umgeni/src/gpu/lower.js';
import { requestDevice } from '../umgeni/src/gpu/runtime.js';
// @ts-expect-error generated at build time, plain JS
import { compileMs, makeRegistry, rasterize2IR } from './gen/pipeline.gen.js';
import { quoteNile } from './src/quote.js';
import textNl from './nl/text.nl';
import spansNl from './nl/spans.nl';
import rasterizeNl from '../gezira/rasterize.nl';
import rasterize2Nl from '../umgeni/nl/rasterize2.nl';

(document.getElementById('nile') as HTMLElement).textContent = quoteNile(
  [textNl, spansNl, rasterizeNl, rasterize2Nl],
  ['TextSpans', 'TextLayout', 'WordWidths', 'LayoutGlyphs', 'Rasterize', 'Rasterize2', 'PaintSpans'],
);

const registry = makeRegistry(rt);

const canvas2d = document.getElementById('canvas') as HTMLCanvasElement;
const canvasGpu = document.getElementById('canvasgpu') as HTMLCanvasElement;
const textEl = document.getElementById('text') as HTMLTextAreaElement;
const sizeEl = document.getElementById('size') as HTMLInputElement;
const modeEl = document.getElementById('mode') as HTMLSelectElement;
const sizeVal = document.getElementById('sizeval')!;
const stats = document.getElementById('stats')!;
const ctx2d = canvas2d.getContext('2d')!;

const SIZE = { width: canvas2d.width, height: canvas2d.height };

// Fonts: Source Serif 4 with Twemoji colour emoji as fallback (bundled), the
// hand-drawn stub, or any dropped .ttf (also with emoji fallback).
const fontEl = document.getElementById('font') as HTMLSelectElement;
const fonts = new Map<string, { glyphs: GlyphSource; lineHeight: number }>();
const serif = parseTrueType(sourceSerif as Uint8Array);
const emoji = parseTrueType(twemoji as Uint8Array);
fonts.set('serif', { glyphs: fallback(serif, emoji), lineHeight: serif.lineHeight });
fonts.set('stub', { glyphs: stubGlyph, lineHeight: 1.15 });
const currentFont = () => fonts.get(fontEl.value) ?? fonts.get('serif')!;
const TEXT_COLOR = [24, 24, 24] as const;

interface GpuState {
  device: GPUDevice;
  shaders: LoweredShaders;
  raster: GpuRasterizer;
  presenter: TigerGpu;
  context: GPUCanvasContext;
}
let gpuState: GpuState | 'unavailable' | null = null;

async function ensureGpu(): Promise<GpuState | null> {
  if (gpuState === 'unavailable') return null;
  if (gpuState) return gpuState;
  const device = await requestDevice();
  const context = canvasGpu.getContext('webgpu');
  if (!device || !context) {
    gpuState = 'unavailable';
    return null;
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  const shaders = lowerFusedPipeline(rasterize2IR, SIZE); // WGSL from IR, in-browser
  gpuState = {
    device,
    shaders,
    context,
    raster: createRasterHost(device, shaders.decompose, shaders.resolve, SIZE),
    presenter: createTigerGpu(device, shaders, { ...SIZE, format }), // one black path
  };
  return gpuState;
}

function paint(buf: ArrayLike<number>): number {
  const t0 = performance.now();
  const { width, height } = SIZE;
  const img = ctx2d.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const v = Math.round(255 * (1 - Math.min(1, buf[i])));
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx2d.putImageData(img, 0, 0);
  return performance.now() - t0;
}

// Laid-out colour runs (Nile layout), each then transformed and clipped (Nile).
function runs(text: string, params: number[]): ColorRun[] {
  return colorRuns(registry['TextLayout']([params[0], params[1]]), text, currentFont().glyphs);
}
const rgb255 = (r: ColorRun) => (r.color ? [r.color[0] * 255, r.color[1] * 255, r.color[2] * 255] as const : TEXT_COLOR);
function placed(run: ColorRun, params: number[]): number[][] {
  const op = rt.pipeline([registry['TransformBeziers'](params.slice(2, 8)), registry['ClipBeziers'](params.slice(8, 12))]);
  return collectSpans(op, run.beziers);
}

// CPU front half for the (single-colour) readback path.
function frontHalf(text: string, params: number[]): Float32Array<ArrayBuffer> {
  const op = rt.pipeline([
    registry['TextLayout']([params[0], params[1]]),
    registry['TransformBeziers'](params.slice(2, 8)),
    registry['ClipBeziers'](params.slice(8, 12)),
  ]);
  const out: number[] = [];
  op.setEmit((t: number[]) => out.push(...t));
  for (const t of textTokens(text, currentFont().glyphs)) op.push(t);
  op.end();
  return new Float32Array(out);
}

async function render(): Promise<void> {
  const size = Number(sizeEl.value);
  sizeVal.textContent = String(size);
  const params = textSpansParams({ size, ...SIZE, margin: 8, lineHeight: currentFont().lineHeight });
  const text = textEl.value;
  const mode = modeEl.value;

  canvas2d.style.display = mode === 'gpu0' ? 'none' : '';
  canvasGpu.style.display = mode === 'gpu0' ? '' : 'none';

  if (mode === 'gpu' || mode === 'gpu0') {
    const gpu = await ensureGpu();
    if (!gpu) {
      stats.textContent = 'WebGPU unavailable in this browser/context — falling back to CPU.';
      modeEl.value = 'cpu';
      return render();
    }
    if (mode === 'gpu0') {
      let t0 = performance.now();
      const batches = runs(text, params).map((r) => {
        const bs = placed(r, params);
        const c = rgb255(r);
        return { beziers: new Float32Array(bs.flat()), n: bs.length, color: [c[0] / 255, c[1] / 255, c[2] / 255] as const };
      });
      const frontMs = performance.now() - t0;
      t0 = performance.now();
      gpu.presenter.frame(batches, gpu.context.getCurrentTexture().createView());
      const submitMs = performance.now() - t0;
      stats.textContent =
        `GPU zero-fence · ${batches.reduce((n, b) => n + b.n, 0)} beziers in ${batches.length} colour runs · ` +
        `front (CPU Nile) ${frontMs.toFixed(1)} ms · submit ${submitMs.toFixed(2)} ms · fences: 0 (presented async)`;
      return;
    }

    let t0 = performance.now();
    const beziers = frontHalf(text, params);
    const frontMs = performance.now() - t0;
    const n = beziers.length / 6;

    t0 = performance.now();
    const coverage = await gpu.raster.render(beziers, n);
    const gpuMs = performance.now() - t0;
    const paintMs = paint(coverage);
    stats.textContent =
      `GPU readback · ${n} beziers · front ${frontMs.toFixed(1)} ms · ` +
      `raster ${gpuMs.toFixed(1)} ms (1 fence) · paint ${paintMs.toFixed(1)} ms` +
      (gpu.raster.overflowed() ? ' · WORKLIST OVERFLOW' : '');
    return;
  }

  // CPU: each colour run rasterized (Nile) and composited in order.
  const t0 = performance.now();
  const img = ctx2d.createImageData(SIZE.width, SIZE.height);
  img.data.fill(255);
  let spans = 0;
  const colourRuns = runs(text, params);
  for (const r of colourRuns) {
    const s = collectSpans(registry['Rasterize'](), placed(r, params));
    spans += s.length;
    paintSpans(img, registry, s, rgb255(r));
  }
  ctx2d.putImageData(img, 0, 0);
  stats.textContent =
    `CPU · compile ${compileMs} ms (build time) · ${colourRuns.length} colour runs → ` +
    `${spans.toLocaleString()} spans · ${(performance.now() - t0).toFixed(1)} ms`;
}

const rerender = () => void render();
textEl.addEventListener('input', rerender);
sizeEl.addEventListener('input', rerender);
modeEl.addEventListener('change', rerender);
fontEl.addEventListener('change', rerender);

// Drop a TrueType font anywhere on the page to set the text in it.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  try {
    const font = parseTrueType(new Uint8Array(await file.arrayBuffer()));
    const key = `drop:${file.name}`;
    fonts.set(key, { glyphs: fallback(font, emoji), lineHeight: font.lineHeight });
    if (![...fontEl.options].some((o) => o.value === key)) fontEl.add(new Option(file.name, key));
    fontEl.value = key;
    rerender();
  } catch (err) {
    stats.textContent = `Could not read ${file.name}: ${(err as Error).message}`;
  }
});
rerender();
