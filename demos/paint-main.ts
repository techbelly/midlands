// Paint: the Umgeni compiler running in the browser. Your Nile text plus
// gezira's library is parsed, elaborated, optimized and turned into JS on
// every edit; three shapes are then rasterized and painted with `Paint` —
// on the CPU, or on the GPU with `Paint` lowered to a WGSL function.

import { compileLibrary, type CompiledLibrary } from '../umgeni/src/compile.js';
import { createPresenter, framePlan, type Presenter } from '../umgeni/src/gpu/present.js';
import { lowerTexture, type LoweredTexture } from '../umgeni/src/gpu/texture.js';
import { configureCanvas, gpuDevice, showOnly, type GpuCanvas } from './src/gpu-page.js';
import { Resolution } from './src/resolution.js';
import { fusedPipeline } from '../umgeni/src/ir.js';
import { PAINT_GLUE, paintShapes } from './src/vector/paint.js';
import { writePixels } from './src/vector/spans.js';
import { PRESETS } from './paint-presets.js';
import { quoteNile } from './src/quote.js';
import { sources } from './nl/paint.nl-lib';

(document.getElementById('nile') as HTMLElement).textContent = quoteNile(
  [PAINT_GLUE, ...sources],
  ['PaintBeziers', 'Rasterize', 'ApplyTexture', 'ExpandSpans'],
);

const editor = document.getElementById('src') as HTMLTextAreaElement;
const presetEl = document.getElementById('preset') as HTMLSelectElement;
const modeEl = document.getElementById('mode') as HTMLSelectElement;
const statusEl = document.getElementById('perf')!; // the live line: compile and frame times, or the error
const statsEl = document.getElementById('stats')!;
const shaderEl = document.getElementById('shader')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const canvasGpu = document.getElementById('viewgpu') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
// The picture's size as the page declares it; drawn at that or at device
// resolution (see render), with the shapes scaled to match.
const DECLARED = { width: canvas.width, height: canvas.height };

let library: CompiledLibrary | null = null;
let compileNote = ''; // how long the compile took
let compileStats = ''; // what it produced

function compile(): boolean {
  const t0 = performance.now();
  try {
    const p = compileLibrary([...sources, editor.value, PAINT_GLUE]);
    const ms = performance.now() - t0;
    // The library compiles completely, so anything unsupported is from the
    // editor (or depends on something there that is).
    if (p.unsupported.length > 0 || !('PaintBeziers' in p.api)) {
      const why = p.unsupported.map((u) => `${u.name}: ${u.reason}`).join('\n');
      statusEl.textContent = why || 'Define `Paint : Point >> Color`.';
      statusEl.className = 'err';
      return false;
    }
    library = p;
    statusEl.className = '';
    compileNote = `Compiled in your browser in ${ms.toFixed(0)} ms.`;
    compileStats = `${p.modules.reduce((n, m) => n + m.decls.length, 0)} declarations → ${(p.source.length / 1024).toFixed(0)} KB of JS`;
    return true;
  } catch (e) {
    statusEl.textContent = String((e as Error).message ?? e);
    statusEl.className = 'err';
    return false;
  }
}

// --- GPU: RasterizeParallel lowered from source; paint() lowered from your Nile ---

let target: GpuCanvas | null | undefined; // undefined: not asked yet
// The presenter for a paint(): rebuilt when the paint changes.
interface GpuPaint { paint: string; width: number; height: number; renderer: Presenter; context: GPUCanvasContext }
let gpu: GpuPaint | null = null;

async function gpuPaint(p: CompiledLibrary, paint: string, W: number, H: number): Promise<GpuPaint | null> {
  if (target === undefined) {
    const device = await gpuDevice();
    target = device && configureCanvas(device, canvasGpu);
  }
  if (!target) return null;
  if (gpu?.paint !== paint || gpu.width !== W || gpu.height !== H) {
    gpu?.renderer.dispose();
    const plan = framePlan(fusedPipeline(p.ir, 'RasterizePixels'), W, H);
    gpu = { paint, width: W, height: H, renderer: createPresenter(target.device, plan, { format: target.format, paint }), context: target.context };
  }
  return gpu;
}

// Where this frame paints: on the GPU with this presenter, or on the CPU,
// and if the menu asked for the GPU, why not.
type Where = { gpu: GpuPaint } | { why: string };
async function whereToPaint(p: CompiledLibrary, tex: LoweredTexture, W: number, H: number): Promise<Where> {
  if (modeEl.value !== 'gpu') return { why: '' };
  if (!tex.ok) return { why: '  This texture is CPU-only (see the shader panel).' };
  const g = await gpuPaint(p, tex.wgsl, W, H);
  return g ? { gpu: g } : { why: '  WebGPU unavailable — painted on the CPU.' };
}

async function render(): Promise<void> {
  if (!library) return;
  const p = library;
  resolution.fit(canvas, DECLARED.width, DECLARED.height);
  resolution.fit(canvasGpu, DECLARED.width, DECLARED.height);
  const W = canvas.width;
  const H = canvas.height;
  const t0 = performance.now();
  const shapes = paintShapes(p.api, W, H, resolution.scale);
  const geomMs = performance.now() - t0;
  const tex = lowerTexture(p.ir, 'Paint');
  shaderEl.textContent = tex.ok ? tex.wgsl : `// Not lowered to the GPU: ${tex.reason}\n// (filters take several samples per point; they paint on the CPU)`;

  const where = await whereToPaint(p, tex, W, H);
  showOnly('gpu' in where ? canvasGpu : canvas, canvas, canvasGpu);
  if ('gpu' in where) paintOnGpu(where.gpu, shapes, geomMs);
  else paintOnCpu(p, shapes, t0, where.why, W, H);
}

function paintOnGpu({ renderer, context, width, height }: GpuPaint, shapes: number[][][], geomMs: number): void {
  const t1 = performance.now();
  renderer.frame(
    shapes.map((bs) => ({ tokens: new Float32Array(bs.flat()), n: bs.length, color: [0, 0, 0] as const })),
    context.getCurrentTexture().createView(),
  );
  statsEl.textContent = `${compileStats} · ${resolution.label(width, height)}`;
  statusEl.textContent = `${compileNote}  Geometry ${geomMs.toFixed(0)} ms (CPU Nile); ` +
    `raster + paint on the GPU, submitted in ${(performance.now() - t1).toFixed(1)} ms, zero fences.`;
}

function paintOnCpu(p: CompiledLibrary, shapes: number[][][], t0: number, note: string, W: number, H: number): void {
  const img = ctx.createImageData(W, H);
  img.data.fill(255);
  let px = 0;
  for (const bs of shapes) {
    const out = p.api.PaintBeziers({ min: [0, 0], max: [W, H] }).run(bs);
    px += out.length;
    writePixels(img, p.api, out);
  }
  ctx.putImageData(img, 0, 0);
  statsEl.textContent = `${compileStats} · ${px.toLocaleString()} pixels · ${resolution.label(W, H)}`;
  statusEl.textContent = `${compileNote}  Painted on the CPU in ${(performance.now() - t0).toFixed(0)} ms.${note}`;
}

const resolution = new Resolution(() => void render());

function update(): void {
  if (compile()) {
    render().catch((e) => {
      statusEl.textContent = `Runtime error: ${(e as Error).message}`;
      statusEl.className = 'err';
    });
  }
}

let timer = 0;
editor.addEventListener('input', () => {
  clearTimeout(timer);
  timer = window.setTimeout(update, 300);
});
for (const [i, p] of PRESETS.entries()) presetEl.add(new Option(p.name, String(i)));
presetEl.addEventListener('change', () => {
  editor.value = PRESETS[Number(presetEl.value)].source;
  update();
});
modeEl.addEventListener('change', update);
editor.value = PRESETS[0].source;
update();
