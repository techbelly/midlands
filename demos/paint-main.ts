// Paint: the Umgeni compiler running in the browser. Your Nile text plus
// gezira's library is parsed, elaborated, optimized and turned into JS on
// every edit; three shapes are then rasterized and painted with `Paint` —
// on the CPU, or on the GPU with `Paint` lowered to a WGSL function.

import { compileLibrary, type CompiledLibrary } from '../umgeni/src/compile.js';
import { createPresenter, type Presenter } from '../umgeni/src/gpu/present.js';
import { lowerPipeline } from '../umgeni/src/gpu/lower.js';
import { coverageSink } from '../umgeni/src/gpu/execute.js';
import { lowerTexture, type LoweredTexture } from '../umgeni/src/gpu/texture.js';
import { requestDevice } from '../umgeni/src/gpu/device.js';
import { fusedPipeline } from '../umgeni/src/ir.js';
import { PAINT_GLUE, paintShapes } from './src/vector/paint.js';
import { writePixels } from './src/vector/spans.js';
import { PRESETS } from './paint-presets.js';
import types from '../gezira/types.nl';
import bezier from '../gezira/bezier.nl';
import stroke from '../gezira/stroke.nl';
import rasterize from '../gezira/rasterize.nl';
import texture from '../gezira/texture.nl';
import compositor from '../gezira/compositor.nl';
import gradient from '../gezira/gradient.nl';
import filter from '../gezira/filter.nl';
import vector from '../roda/vector.nl';
import spans from '../roda/spans.nl';
import rasterizeParallel from '../roda/rasterize-parallel.nl';
import { quoteNile } from './src/quote.js';

(document.getElementById('nile') as HTMLElement).textContent = quoteNile(
  [PAINT_GLUE, texture, rasterize],
  ['PaintBeziers', 'Rasterize', 'ApplyTexture', 'ExpandSpans'],
);

const LIBRARY: string[] = [types, bezier, stroke, rasterize, texture, compositor, gradient, filter, vector, spans, rasterizeParallel];

const editor = document.getElementById('src') as HTMLTextAreaElement;
const presetEl = document.getElementById('preset') as HTMLSelectElement;
const modeEl = document.getElementById('mode') as HTMLSelectElement;
const statusEl = document.getElementById('perf')!; // the live line: compile and frame times, or the error
const statsEl = document.getElementById('stats')!;
const shaderEl = document.getElementById('shader')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const canvasGpu = document.getElementById('viewgpu') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const W = canvas.width;
const H = canvas.height;

let library: CompiledLibrary | null = null;
let compileNote = ''; // how long the compile took
let compileStats = ''; // what it produced

function compile(): boolean {
  const t0 = performance.now();
  try {
    const p = compileLibrary([...LIBRARY, editor.value, PAINT_GLUE]);
    const ms = performance.now() - t0;
    // The library compiles completely, so anything unsupported is from the
    // editor (or depends on something there that is).
    if (p.unsupported.length > 0 || !p.registry.has('PaintBeziers')) {
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

let device: GPUDevice | null | undefined;
let gpuContext: GPUCanvasContext | null = null;
let gpu: { paint: string; renderer: Presenter } | null = null;

async function gpuRenderer(p: CompiledLibrary, paint: string): Promise<Presenter | null> {
  if (device === undefined) {
    device = await requestDevice();
    gpuContext = device ? canvasGpu.getContext('webgpu') : null;
    gpuContext?.configure({ device: device!, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
  }
  if (!device || !gpuContext) return null;
  if (gpu?.paint !== paint) {
    gpu?.renderer.dispose();
    const plan = lowerPipeline(fusedPipeline(p.ir, 'RasterizePixels'), { extent: [H, W], sink: coverageSink });
    const format = navigator.gpu.getPreferredCanvasFormat();
    gpu = { paint, renderer: createPresenter(device, plan, { format, paint }) };
  }
  return gpu.renderer;
}

// Where this frame paints: on the GPU with this presenter, or on the CPU,
// and if the menu asked for the GPU, why not.
type Where = { renderer: Presenter } | { why: string };
async function whereToPaint(p: CompiledLibrary, tex: LoweredTexture): Promise<Where> {
  if (modeEl.value !== 'gpu') return { why: '' };
  if (!tex.ok) return { why: '  This texture is CPU-only (see the shader panel).' };
  const renderer = await gpuRenderer(p, tex.wgsl);
  return renderer ? { renderer } : { why: '  WebGPU unavailable — painted on the CPU.' };
}

async function render(): Promise<void> {
  if (!library) return;
  const p = library;
  const t0 = performance.now();
  const shapes = paintShapes(p.api, W, H);
  const geomMs = performance.now() - t0;
  const tex = lowerTexture(p.ir, 'Paint');
  shaderEl.textContent = tex.ok ? tex.wgsl : `// Not lowered to the GPU: ${tex.reason}\n// (filters take several samples per point; they paint on the CPU)`;

  const where = await whereToPaint(p, tex);
  const onGpu = 'renderer' in where;
  canvas.style.display = onGpu ? 'none' : '';
  canvasGpu.style.display = onGpu ? '' : 'none';
  if ('renderer' in where) paintOnGpu(where.renderer, shapes, geomMs);
  else paintOnCpu(p, shapes, t0, where.why);
}

function paintOnGpu(renderer: Presenter, shapes: number[][][], geomMs: number): void {
  const t1 = performance.now();
  renderer.frame(
    shapes.map((bs) => ({ tokens: new Float32Array(bs.flat()), n: bs.length, color: [0, 0, 0] as const })),
    gpuContext!.getCurrentTexture().createView(),
  );
  statsEl.textContent = compileStats;
  statusEl.textContent = `${compileNote}  Geometry ${geomMs.toFixed(0)} ms (CPU Nile); ` +
    `raster + paint on the GPU, submitted in ${(performance.now() - t1).toFixed(1)} ms, zero fences.`;
}

function paintOnCpu(p: CompiledLibrary, shapes: number[][][], t0: number, note: string): void {
  const img = ctx.createImageData(W, H);
  img.data.fill(255);
  let px = 0;
  for (const bs of shapes) {
    const out = p.api.PaintBeziers({ min: [0, 0], max: [W, H] }).run(bs);
    px += out.length;
    writePixels(img, p.api, out);
  }
  ctx.putImageData(img, 0, 0);
  statsEl.textContent = `${compileStats} · ${px.toLocaleString()} pixels`;
  statusEl.textContent = `${compileNote}  Painted on the CPU in ${(performance.now() - t0).toFixed(0)} ms.${note}`;
}

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
