// The web demo shell: DOM in, pixels out. The pipeline itself is
// nl/text.nl-lib — compiled by Umgeni at bundle time (tools/nile-plugin.ts)
// into generated JS plus RasterizeParallel as fused IR (plain data).
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

import { colorRuns, fallback, textBeziers, textSpansParams, type ColorRun, type GlyphSource, type TextSpansParams } from './src/text/host.js';
import { glyphFor as stubGlyph } from './src/text/stubfont.js';
import { parseTrueType } from './src/text/ttf.js';
import { paintSpans, type RGB } from './src/vector/spans.js';
// Source Serif 4: SIL OFL 1.1 (fonts/OFL.txt)
import sourceSerif from './fonts/SourceSerif4.ttf';
// Twemoji Mozilla: CC-BY 4.0 art (fonts/TWEMOJI-LICENSE.md)
import twemoji from './fonts/Twemoji.Mozilla.ttf';
import { createRasterHost, type GpuRasterizer } from '../umgeni/src/gpu/raster.js';
import { createPresenter, framePlan, type Presenter } from '../umgeni/src/gpu/present.js';
import { configureCanvas, gpuDevice, showOnly } from './src/gpu-page.js';
import { compileMs, nile, nileWasm, sources, RasterizePixelsIR } from './nl/text.nl-lib';
import { quoteNile } from './src/quote.js';
import { frameScheduler } from './src/schedule.js';

(document.getElementById('nile') as HTMLElement).textContent = quoteNile(
  sources,
  ['TextSpans', 'TextBeziers', 'PlaceBeziers', 'TextLayout', 'WordWidths', 'LayoutGlyphs', 'Rasterize', 'RasterizeParallel', 'RasterizePixels', 'PaintSpans'],
);


const canvas2d = document.getElementById('canvas') as HTMLCanvasElement;
const canvasGpu = document.getElementById('canvasgpu') as HTMLCanvasElement;
const textEl = document.getElementById('text') as HTMLTextAreaElement;
const sizeEl = document.getElementById('size') as HTMLInputElement;
const modeEl = document.getElementById('mode') as HTMLSelectElement;
const sizeVal = document.getElementById('sizeval')!;
const stats = document.getElementById('stats')!;
const perf = document.getElementById('perf')!;
const ctx2d = canvas2d.getContext('2d')!;
type Api = typeof nile;

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
const TEXT_COLOR = [24 / 255, 24 / 255, 24 / 255] as const;
const colorOf = (r: ColorRun) => r.color ?? TEXT_COLOR; // 0..1
const rgb255 = (r: ColorRun): RGB => { const [cr, cg, cb] = colorOf(r); return [cr * 255, cg * 255, cb * 255]; };

// --- the Nile, run on the CPU: the front half every renderer shares ---

// Laid-out colour runs (Nile layout), each then transformed and clipped (Nile).
function runs(api: Api, text: string, { w, lh }: TextSpansParams): ColorRun[] {
  return colorRuns(api, api.TextLayout({ w, lh }), text, currentFont().glyphs);
}
function placed(api: Api, run: ColorRun, { M, min, max }: TextSpansParams): number[][] {
  return api.PlaceBeziers({ M, min, max }).run(run.beziers);
}

// The single-colour front half, for the readback path: every glyph's beziers, flat.
const glyphBeziers = (text: string, params: TextSpansParams): Float32Array<ArrayBuffer> =>
  new Float32Array(textBeziers(nile, text, params, currentFont().glyphs).flat());

// --- the renderers: one per entry in the renderer menu ---

// A renderer draws one frame on its canvas and reports what it did: the
// counts (stats) and the timings (perf).
interface Renderer {
  canvas: HTMLCanvasElement;
  frame(text: string, params: TextSpansParams): Promise<{ stats: string; perf: string }>;
}

// CPU: each colour run rasterized (Nile) and composited in order. The
// library compiled to JavaScript or to WebAssembly, the same Nile.
function cpuRenderer(api: Api, label: string): Renderer {
  return {
    canvas: canvas2d,
    async frame(text, params) {
      const t0 = performance.now();
      const img = ctx2d.createImageData(SIZE.width, SIZE.height);
      img.data.fill(255);
      let spans = 0;
      const colourRuns = runs(api, text, params);
      for (const r of colourRuns) {
        const s = api.Rasterize().run(placed(api, r, params));
        spans += s.length;
        paintSpans(img, api, s, rgb255(r));
      }
      ctx2d.putImageData(img, 0, 0);
      return {
        stats: `${colourRuns.length} colour runs → ${spans.toLocaleString()} spans · compiled in ${compileMs} ms (at build time)`,
        perf: `CPU (${label}) · ${(performance.now() - t0).toFixed(1)} ms`,
      };
    },
  };
}

// GPU, read back: the front half on the CPU, the rasterizer on the GPU, the
// coverage read back (one fence) and drawn in grey through the 2D canvas.
function readbackRenderer(gpu: Gpu): Renderer {
  return {
    canvas: canvas2d,
    async frame(text, params) {
      let t0 = performance.now();
      const beziers = glyphBeziers(text, params);
      const frontMs = performance.now() - t0;
      const n = beziers.length / 6;
      t0 = performance.now();
      const coverage = await gpu.raster.render(beziers, n);
      const gpuMs = performance.now() - t0;
      const paintMs = drawCoverage(coverage);
      return {
        stats: `${n} beziers`,
        perf: `GPU readback · front ${frontMs.toFixed(1)} ms · raster ${gpuMs.toFixed(1)} ms (1 fence) · paint ${paintMs.toFixed(1)} ms` +
          (gpu.raster.overflowed() ? ' · WORKLIST OVERFLOW' : ''),
      };
    },
  };
}

// GPU, presented: the colour runs rasterized and composited on the GPU in
// one submission to a WebGPU canvas, zero fences.
function presentedRenderer(gpu: Gpu): Renderer {
  return {
    canvas: canvasGpu,
    async frame(text, params) {
      let t0 = performance.now();
      const batches = runs(nile, text, params).map((r) => {
        const bs = placed(nile, r, params);
        return { tokens: new Float32Array(bs.flat()), n: bs.length, color: colorOf(r) };
      });
      const frontMs = performance.now() - t0;
      t0 = performance.now();
      gpu.presenter.frame(batches, gpu.context.getCurrentTexture().createView());
      const submitMs = performance.now() - t0;
      return {
        stats: `${batches.reduce((n, b) => n + b.n, 0)} beziers in ${batches.length} colour runs`,
        perf: `GPU zero-fence · front (CPU Nile) ${frontMs.toFixed(1)} ms · submit ${submitMs.toFixed(2)} ms · fences: 0 (presented async)`,
      };
    },
  };
}

// Coverage drawn as grey through the 2D canvas; returns the time it took.
function drawCoverage(buf: ArrayLike<number>): number {
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

// --- WebGPU, set up once: the rasterizer lowered in the browser ---

interface Gpu {
  device: GPUDevice;
  raster: GpuRasterizer;
  presenter: Presenter;
  context: GPUCanvasContext;
}
let gpuState: Gpu | 'unavailable' | null = null;

async function ensureGpu(): Promise<Gpu | null> {
  if (gpuState === 'unavailable') return null;
  if (gpuState) return gpuState;
  const device = await gpuDevice();
  const target = device && configureCanvas(device, canvasGpu);
  if (!device || !target) {
    gpuState = 'unavailable';
    return null;
  }
  const plan = framePlan(RasterizePixelsIR, SIZE.width, SIZE.height); // WGSL from IR, in-browser
  gpuState = {
    device,
    context: target.context,
    raster: createRasterHost(device, plan),
    presenter: createPresenter(device, plan, { format: target.format }), // one black path
  };
  return gpuState;
}

// The renderer the menu names, or null when it needs a GPU this browser lacks.
async function renderer(mode: string): Promise<Renderer | null> {
  if (mode === 'cpu') return cpuRenderer(nile, 'JavaScript');
  if (mode === 'wasm') return cpuRenderer(nileWasm, 'WebAssembly');
  const gpu = await ensureGpu();
  if (!gpu) return null;
  return mode === 'gpu0' ? presentedRenderer(gpu) : readbackRenderer(gpu);
}

async function render(): Promise<void> {
  const size = Number(sizeEl.value);
  sizeVal.textContent = String(size);
  const params = textSpansParams({ size, ...SIZE, margin: 8, lineHeight: currentFont().lineHeight });
  const r = await renderer(modeEl.value);
  if (!r) {
    perf.textContent = 'WebGPU unavailable in this browser/context — falling back to CPU.';
    modeEl.value = 'cpu';
    return render();
  }
  showOnly(r.canvas, canvas2d, canvasGpu);
  const done = await r.frame(textEl.value, params);
  stats.textContent = done.stats;
  perf.textContent = done.perf;
}

const rerender = frameScheduler(render);
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
    perf.textContent = `Could not read ${file.name}: ${(err as Error).message}`;
  }
});
rerender();
