// The tiger demo shell: zoom/pan state and canvas plumbing. Ported from
// chari/web/tiger-main.ts; the pipeline is Umgeni-compiled (nl/vector.nl-lib).

import { parseSvg } from './src/vector/svg.js';
import type { Api } from './src/vector/draw.js';
import { paintPaths, tigerPaths, toBatches, type TigerPath } from './src/vector/tiger.js';
import type { FusedIR } from '../umgeni/src/ir.js';
import { createPresenter } from '../umgeni/src/gpu/present.js';
import { lowerPipeline } from '../umgeni/src/gpu/lower.js';
import { coverageSink } from '../umgeni/src/gpu/execute.js';
import { requestDevice } from '../umgeni/src/gpu/device.js';
import { nile, nileWasm, sources, RasterizePixelsIR } from './nl/vector.nl-lib';
import svgSrc from './tiger.svg';
import { quoteNile } from './src/quote.js';
import { frameScheduler } from './src/schedule.js';

(document.getElementById('nile') as HTMLElement).textContent = quoteNile(
  sources,
  ['PathCubics', 'SvgFillBeziers', 'SvgStroke', 'StrokeOutline', 'StrokeBezierPath', 'ClipBeziers', 'RasterizeParallel', 'RasterizePixels', 'PaintSpans'],
);

const tiger = parseSvg(svgSrc, nile);

const canvas = document.getElementById('view') as HTMLCanvasElement;
const canvasGpu = document.getElementById('viewgpu') as HTMLCanvasElement;
const modeEl = document.getElementById('mode') as HTMLSelectElement;
const statsEl = document.getElementById('stats')!;
const perfEl = document.getElementById('perf')!;
const base = Math.min(canvas.width, canvas.height) / 900;

// A back end rasterizes and composites the paths, and resolves to its time
// in ms. Each is built once from the compiled library and the canvas it
// draws on — the same Nile either way: RasterizeParallel → PaintSpans as
// JS for the CPU, RasterizePixels as WGSL lowered from its IR for the GPU.
type BackEnd = (paths: TigerPath[]) => Promise<number>;

function cpuBackEnd(nile: Api, ctx: CanvasRenderingContext2D): BackEnd {
  const { width, height } = ctx.canvas;
  return async (paths) => {
    const t0 = performance.now();
    const img = ctx.createImageData(width, height);
    img.data.fill(255);
    paintPaths(img, nile, paths);
    ctx.putImageData(img, 0, 0);
    return performance.now() - t0;
  };
}

function gpuBackEnd(ir: FusedIR, device: GPUDevice, context: GPUCanvasContext): BackEnd {
  const { width, height } = context.canvas;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  const plan = lowerPipeline(ir, { extent: [height, width], sink: coverageSink }); // WGSL from IR, in-browser
  const presenter = createPresenter(device, plan, { format });
  return async (paths) => {
    const t0 = performance.now();
    presenter.frame(toBatches(paths), context.getCurrentTexture().createView());
    // The GPU runs after submit; wait for it, so the next frame starts on a
    // free GPU and the figures add up to what a frame really takes.
    await device.queue.onSubmittedWorkDone();
    return performance.now() - t0;
  };
}

const cpu = cpuBackEnd(nile, canvas.getContext('2d')!);
const wasm = cpuBackEnd(nileWasm, canvas.getContext('2d')!);

// The GPU back end is built on first use, if WebGPU is there.
let gpu: BackEnd | 'unavailable' | null = null;
async function ensureGpu(): Promise<BackEnd | null> {
  if (gpu === null) {
    const device = await requestDevice();
    const context = canvasGpu.getContext('webgpu');
    gpu = device && context ? gpuBackEnd(RasterizePixelsIR, device, context) : 'unavailable';
  }
  return gpu === 'unavailable' ? null : gpu;
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

// The front half (geometry, compiled Nile on the CPU) is the same in both
// modes; only the back end — rasterize and composite — differs.
async function draw(): Promise<void> {
  const gpuBack = modeEl.value === 'gpu' ? await ensureGpu() : null;
  if (modeEl.value === 'gpu' && !gpuBack) modeEl.value = 'cpu'; // the fallback when WebGPU is unavailable
  show(gpuBack ? canvasGpu : canvas);
  const isWasm = !gpuBack && modeEl.value === 'wasm';
  const backEnd = gpuBack ?? (isWasm ? wasm : cpu);
  const front = isWasm ? nileWasm : nile; // the front half runs as wasm only in the wasm mode

  const t0 = performance.now();
  const paths = tigerPaths(tiger, viewMatrix(), front, canvas.width, canvas.height);
  const frontMs = performance.now() - t0;
  const backMs = await backEnd(paths);
  statsEl.textContent = `${tiger.paths.length} paths · ${segs.toLocaleString()} cubics · ${z.toFixed(1)}×`;
  perfEl.textContent =
    `front (CPU Nile, ${isWasm ? 'wasm' : 'JS'}) ${frontMs.toFixed(0)} ms + raster & composite (${gpuBack ? 'GPU' : isWasm ? 'CPU wasm' : 'CPU JS'}) ${backMs.toFixed(0)} ms ` +
    `= ${(frontMs + backMs).toFixed(0)} ms a frame`;
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
perfEl.textContent = 'rendering…';
scheduleDraw();
