// Paint: the Umgeni compiler running in the browser. Your Nile text plus
// gezira's library is parsed, elaborated, optimized and turned into JS on
// every edit; three shapes are then rasterized and painted with `Paint` —
// on the CPU, or on the GPU with `Paint` lowered to a WGSL function.

import { compileProgram, type CompiledProgram } from '../umgeni/src/compile.js';
import { createTigerGpu, type TigerGpu } from '../umgeni/src/gpu/tiger.js';
import { lowerFusedPipeline } from '../umgeni/src/gpu/lower.js';
import { lowerTexture } from '../umgeni/src/gpu/texture.js';
import { requestDevice } from '../umgeni/src/gpu/runtime.js';
import { collectSpans } from './src/vector/draw.js';
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
import vector from './nl/vector.nl';
import spans from './nl/spans.nl';
import rasterize2 from '../umgeni/nl/rasterize2.nl';
import { quoteNile } from './src/quote.js';

(document.getElementById('nile') as HTMLElement).textContent = quoteNile(
  [PAINT_GLUE, texture, rasterize],
  ['PaintBeziers', 'Rasterize', 'ApplyTexture', 'ExpandSpans'],
);

const LIBRARY: string[] = [types, bezier, stroke, rasterize, texture, compositor, gradient, filter, vector, spans, rasterize2];

const editor = document.getElementById('src') as HTMLTextAreaElement;
const presetEl = document.getElementById('preset') as HTMLSelectElement;
const modeEl = document.getElementById('mode') as HTMLSelectElement;
const statusEl = document.getElementById('status')!;
const shaderEl = document.getElementById('shader')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const canvasGpu = document.getElementById('viewgpu') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const W = canvas.width;
const H = canvas.height;

let program: CompiledProgram | null = null;
let compileNote = '';

function compile(): boolean {
  const t0 = performance.now();
  try {
    const p = compileProgram([...LIBRARY, editor.value, PAINT_GLUE]);
    const ms = performance.now() - t0;
    // The library compiles completely, so anything unsupported is from the
    // editor (or depends on something there that is).
    if (p.unsupported.length > 0 || !p.registry.has('PaintBeziers')) {
      const why = p.unsupported.map((u) => `${u.name}: ${u.reason}`).join('\n');
      statusEl.textContent = why || 'Define `Paint : Point >> Color`.';
      statusEl.className = 'err';
      return false;
    }
    program = p;
    statusEl.className = '';
    compileNote =
      `Compiled in your browser in ${ms.toFixed(0)} ms: ${p.modules.reduce((n, m) => n + m.decls.length, 0)} ` +
      `declarations → ${(p.source.length / 1024).toFixed(0)} KB of JS.`;
    return true;
  } catch (e) {
    statusEl.textContent = String((e as Error).message ?? e);
    statusEl.className = 'err';
    return false;
  }
}

// --- GPU: Rasterize2 lowered from source; paint() lowered from your Nile ---

let device: GPUDevice | null | undefined;
let gpuContext: GPUCanvasContext | null = null;
let gpu: { paint: string; renderer: TigerGpu } | null = null;

async function gpuRenderer(p: CompiledProgram, paint: string): Promise<TigerGpu | null> {
  if (device === undefined) {
    device = await requestDevice();
    gpuContext = device ? canvasGpu.getContext('webgpu') : null;
    gpuContext?.configure({ device: device!, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
  }
  if (!device || !gpuContext) return null;
  if (gpu?.paint !== paint) {
    gpu?.renderer.dispose();
    const fused = p.ir.processes.find((x) => x.k === 'fused' && x.name === 'Rasterize2');
    if (!fused || fused.k !== 'fused') return null;
    const shaders = lowerFusedPipeline(fused, { width: W, height: H });
    const format = navigator.gpu.getPreferredCanvasFormat();
    gpu = { paint, renderer: createTigerGpu(device, shaders, { width: W, height: H, format, paint }) };
  }
  return gpu.renderer;
}

async function render(): Promise<void> {
  if (!program) return;
  const p = program;
  const t0 = performance.now();
  const shapes = paintShapes(p.registry, W, H);
  const geomMs = performance.now() - t0;
  const tex = lowerTexture(p.ir, 'Paint');
  shaderEl.textContent = tex.ok ? tex.wgsl : `// Not lowered to the GPU: ${tex.reason}\n// (filters take several samples per point; they paint on the CPU)`;

  let gpuMode = modeEl.value === 'gpu';
  let note = '';
  if (gpuMode && !tex.ok) {
    gpuMode = false;
    note = '  This texture is CPU-only (see the shader panel).';
  }
  const renderer = gpuMode && tex.ok ? await gpuRenderer(p, tex.wgsl) : null;
  if (gpuMode && !renderer) {
    gpuMode = false;
    note = '  WebGPU unavailable — painted on the CPU.';
  }
  canvas.style.display = gpuMode ? 'none' : '';
  canvasGpu.style.display = gpuMode ? '' : 'none';

  if (gpuMode && renderer) {
    const t1 = performance.now();
    renderer.frame(
      shapes.map((bs) => ({ beziers: new Float32Array(bs.flat()), n: bs.length, color: [0, 0, 0] as const })),
      gpuContext!.getCurrentTexture().createView(),
    );
    statusEl.textContent = `${compileNote}  Geometry ${geomMs.toFixed(0)} ms (CPU Nile); ` +
      `raster + paint on the GPU, submitted in ${(performance.now() - t1).toFixed(1)} ms, zero fences.`;
    return;
  }

  const img = ctx.createImageData(W, H);
  img.data.fill(255);
  let px = 0;
  for (const bs of shapes) {
    const out = collectSpans(p.registry.get('PaintBeziers')!({ min: [0, 0], max: [W, H] }), bs);
    px += out.length;
    writePixels(img, p.registry, out);
  }
  ctx.putImageData(img, 0, 0);
  statusEl.textContent = `${compileNote}  Painted ${px.toLocaleString()} pixels on the CPU in ` +
    `${(performance.now() - t0).toFixed(0)} ms.${note}`;
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
