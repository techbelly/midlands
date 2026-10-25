// The tiger demo shell: zoom/pan state and canvas plumbing. Ported from
// chari/web/tiger-main.ts; the pipeline is Umgeni-compiled (nl/vector.program).

import { parseSvg } from './src/vector/svg.js';
import { drawTiger, tigerBatches } from './src/vector/tiger.js';
import { createPresenter, type Presenter } from '../umgeni/src/gpu/present.js';
import { lowerFusedPipeline } from '../umgeni/src/gpu/lower.js';
import { requestDevice } from '../umgeni/src/gpu/runtime.js';
import { nile } from './nl/vector.program';
import { RasterizeParallelIR } from './nl/text.program';
import svgSrc from './tiger.svg';
import { quoteNile } from './src/quote.js';
import { frameScheduler } from './src/schedule.js';
import svgNl from './nl/svg.nl';
import vectorNl from './nl/vector.nl';
import spansNl from './nl/spans.nl';
import strokeNl from '../gezira/stroke.nl';
import rasterizeNl from '../gezira/rasterize.nl';

(document.getElementById('nile') as HTMLElement).textContent = quoteNile(
  [svgNl, vectorNl, spansNl, strokeNl, rasterizeNl],
  ['PathCubics', 'SvgFill', 'FillPath', 'FillBeziers', 'Rasterize', 'SvgStroke', 'StrokeOutline', 'StrokeBezierPath', 'PaintSpans'],
);

const tiger = parseSvg(svgSrc, nile);

const canvas = document.getElementById('view') as HTMLCanvasElement;
const canvasGpu = document.getElementById('viewgpu') as HTMLCanvasElement;
const modeEl = document.getElementById('mode') as HTMLSelectElement;
const ctx = canvas.getContext('2d')!;
const statsEl = document.getElementById('stats')!;
const base = Math.min(canvas.width, canvas.height) / 900;

interface GpuState {
  gpu: Presenter;
  context: GPUCanvasContext;
  device: GPUDevice;
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
  const size = { width: canvasGpu.width, height: canvasGpu.height };
  const shaders = lowerFusedPipeline(RasterizeParallelIR, size);
  gpuState = { gpu: createPresenter(device, shaders, { ...size, format }), context, device };
  return gpuState;
}

// View state: the viewBox point (fx, fy) sits at the canvas centre, scaled by z.
let z = 1;
let fx = 450;
let fy = 450;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const viewMatrix = (): number[] => {
  const s = base * z;
  return [s, 0, 0, s, canvas.width / 2 - s * fx, canvas.height / 2 - s * fy];
};

const segs = tiger.paths.reduce((a, p) => a + p.cubics.length, 0);

// Only one canvas is visible at a time.
function show(el: HTMLCanvasElement): void {
  canvas.style.display = el === canvas ? '' : 'none';
  canvasGpu.style.display = el === canvasGpu ? '' : 'none';
}

async function draw(): Promise<void> {
  const gpu = modeEl.value === 'gpu' ? await ensureGpu() : null;
  if (gpu) {
    show(canvasGpu);
    await drawGpu(gpu);
  } else {
    modeEl.value = 'cpu'; // also the fallback when WebGPU is unavailable
    show(canvas);
    drawCpu();
  }
}

async function drawGpu(state: GpuState): Promise<void> {
  let t0 = performance.now();
  const batches = tigerBatches(tiger, viewMatrix(), nile, canvasGpu.width, canvasGpu.height);
  const frontMs = performance.now() - t0;
  t0 = performance.now();
  state.gpu.frame(batches, state.context.getCurrentTexture().createView());
  const submitMs = performance.now() - t0;
  // The GPU runs after submit; wait for it, so the next frame starts on a
  // free GPU and the figures add up to what a frame really takes.
  t0 = performance.now();
  await state.device.queue.onSubmittedWorkDone();
  const gpuMs = performance.now() - t0;
  statsEl.textContent =
    `${tiger.paths.length} paths · ${segs.toLocaleString()} cubics · ${z.toFixed(1)}× · ` +
    `front (CPU Nile) ${frontMs.toFixed(0)} ms + submit ${submitMs.toFixed(0)} ms + GPU ${gpuMs.toFixed(0)} ms ` +
    `= ${(frontMs + submitMs + gpuMs).toFixed(0)} ms a frame`;
}

function drawCpu(): void {
  const img = ctx.createImageData(canvas.width, canvas.height);
  img.data.fill(255);
  const t0 = performance.now();
  const paths = drawTiger(img, tiger, viewMatrix(), nile);
  ctx.putImageData(img, 0, 0);
  statsEl.textContent =
    `${paths} paths · ${segs.toLocaleString()} cubic segments · ${z.toFixed(1)}× · ` +
    `${(performance.now() - t0).toFixed(0)} ms (CPU, fused pipelines + bucketed sort)`;
}

const scheduleDraw = frameScheduler(draw);

// View controls, attached to BOTH canvases (only one is visible at a time;
// the GPU canvas needs its own listeners too). Double-click cycles the zoom
// 100% → 200% → 400% → 100%, anchored at the click point; drag pans.
// Pinch-zoom is disabled (trackpad pinch arrives as ctrl+wheel, which we
// swallow; touch pinch is already suppressed by `touch-action: none`).
function addViewControls(el: HTMLCanvasElement): void {
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const mx = ((e.clientX - r.left) * el.width) / r.width;
    const my = ((e.clientY - r.top) * el.height) / r.height;
    const s = base * z;
    const vx = fx + (mx - el.width / 2) / s;
    const vy = fy + (my - el.height / 2) / s;
    z = z >= 4 ? 1 : clamp(z * 2, 1, 4);
    const s2 = base * z;
    fx = vx - (mx - el.width / 2) / s2;
    fy = vy - (my - el.height / 2) / s2;
    scheduleDraw();
  });
  el.addEventListener('wheel', (e) => {
    if (e.ctrlKey) e.preventDefault(); // trackpad pinch: do nothing, quietly
  }, { passive: false });

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = el.getBoundingClientRect();
    const s = (base * z * r.width) / el.width;
    fx -= (e.clientX - lastX) / s;
    fy -= (e.clientY - lastY) / s;
    lastX = e.clientX;
    lastY = e.clientY;
    scheduleDraw();
  });
  el.addEventListener('pointerup', () => {
    dragging = false;
  });
}
addViewControls(canvas);
addViewControls(canvasGpu);

modeEl.addEventListener('change', scheduleDraw);
statsEl.textContent = 'rendering…';
scheduleDraw();
