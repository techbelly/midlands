// The tiger demo shell: zoom/pan state and canvas plumbing. Ported from
// chari/web/tiger-main.ts; the pipeline is Umgeni-compiled (vector.gen.js).

import * as rt from '../umgeni/src/cpu/runtime.js';
import { drawTiger, parseTiger, tigerBatches } from './src/vector/tiger.js';
import { createTigerGpu, type TigerGpu } from '../umgeni/src/gpu/tiger.js';
import { lowerFusedPipeline } from '../umgeni/src/gpu/lower.js';
import { requestDevice } from '../umgeni/src/gpu/runtime.js';
// @ts-expect-error generated at build time, plain JS
import { makeVectorRegistry } from './gen/vector.gen.js';
// @ts-expect-error generated at build time, plain JS
import { rasterize2IR } from './gen/pipeline.gen.js';
// @ts-expect-error text import resolved by esbuild
import svgSrc from './tiger.svg';

const registry = makeVectorRegistry(rt);
const tiger = parseTiger(svgSrc);

const canvas = document.getElementById('view') as HTMLCanvasElement;
const canvasGpu = document.getElementById('viewgpu') as HTMLCanvasElement;
const modeEl = document.getElementById('mode') as HTMLSelectElement;
const ctx = canvas.getContext('2d')!;
const statsEl = document.getElementById('stats')!;
const base = Math.min(canvas.width, canvas.height) / 900;

interface GpuState {
  gpu: TigerGpu;
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
  const size = { width: canvasGpu.width, height: canvasGpu.height };
  const shaders = lowerFusedPipeline(rasterize2IR, size);
  gpuState = { gpu: createTigerGpu(device, shaders, { ...size, format }), context };
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

async function draw(): Promise<void> {
  const gpuMode = modeEl.value === 'gpu';
  canvas.style.display = gpuMode ? 'none' : '';
  canvasGpu.style.display = gpuMode ? '' : 'none';

  if (gpuMode) {
    const state = await ensureGpu();
    if (!state) {
      statsEl.textContent = 'WebGPU unavailable — falling back to CPU.';
      modeEl.value = 'cpu';
      return draw();
    }
    let t0 = performance.now();
    const batches = tigerBatches(tiger, viewMatrix(), registry, canvasGpu.width, canvasGpu.height);
    const frontMs = performance.now() - t0;
    t0 = performance.now();
    state.gpu.frame(batches, state.context.getCurrentTexture().createView());
    const submitMs = performance.now() - t0;
    statsEl.textContent =
      `${tiger.paths.length} paths · ${segs.toLocaleString()} cubics · ${z.toFixed(1)}× · ` +
      `front (CPU Nile) ${frontMs.toFixed(0)} ms · submit ${submitMs.toFixed(0)} ms · fences: 0`;
    return;
  }

  const img = ctx.createImageData(canvas.width, canvas.height);
  img.data.fill(255);
  const t0 = performance.now();
  const paths = drawTiger(img, tiger, viewMatrix(), registry);
  ctx.putImageData(img, 0, 0);
  statsEl.textContent =
    `${paths} paths · ${segs.toLocaleString()} cubic segments · ${z.toFixed(1)}× · ` +
    `${(performance.now() - t0).toFixed(0)} ms (CPU, fused pipelines + bucketed sort)`;
}

let timer = 0;
function scheduleDraw(): void {
  statsEl.textContent = 'rendering…';
  clearTimeout(timer);
  timer = window.setTimeout(draw, 30);
}

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

modeEl.addEventListener('change', () => void draw());
statsEl.textContent = 'rendering…';
requestAnimationFrame(() => requestAnimationFrame(() => void draw()));
