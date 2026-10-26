// The Cairo samples, drawn by Nile: each of Cairo's nineteen samples beside
// the same picture made by compiled Nile, with the Nile that does it. On the
// CPU, the Nile compiled to JavaScript draws every card; on the GPU, the
// cards the presenter can draw (fills and strokes, under either rule) are
// rasterized by RasterizePixels lowered from its IR, and the rest say why
// they are drawn on the CPU.

import { nile, sources, RasterizePixelsIR, RasterizePixelsEvenOddIR } from './nl/samples.nl-lib';
import { parseTrueType } from './src/text/ttf.js';
import { CpuOnly, CpuTarget, GpuTarget, Sheet } from './src/samples/draw.js';
import { SCENES } from './src/samples/scenes.js';
import { parseSvg } from './src/vector/svg.js';
import { drawTiger, fitView } from './src/vector/tiger.js';
import { quoteNile } from './src/quote.js';
import { createPresenter, framePlan, type PathBatch, type Presenter } from '../umgeni/src/gpu/present.js';
import { configureCanvas, gpuDevice, showOnly } from './src/gpu-page.js';
import { blankImage } from './src/vector/spans.js';
import tigerSvg from './tiger.svg';
// Source Serif 4: SIL OFL 1.1 (fonts/OFL.txt). Cairo's samples ask for Sans.
import sourceSerif from './fonts/SourceSerif4.ttf';

const SIZE = 256;
const font = parseTrueType(sourceSerif);
// The picture the image samples use, where Cairo's use a photograph: the
// tiger, drawn by the same Nile at 256 × 256.
const tiger = blankImage(SIZE, SIZE);
drawTiger(tiger, parseSvg(tigerSvg, nile), fitView(SIZE, SIZE), nile);

const modeEl = document.getElementById('mode') as HTMLSelectElement;
const perfEl = document.getElementById('perf')!;
(document.getElementById('nile') as HTMLElement).textContent = quoteNile(sources, ['FillWinding', 'FillEvenOdd', 'StrokeOutline', 'ClipPaint', 'Intersect', 'RasterizeParallel', 'PaintSpans']);
const grid = document.getElementById('samples')!;

// A card: the two canvases (one per kind of context; only one is shown), the
// C, the note saying where it was drawn, and the Nile.
interface Card {
  cpu: HTMLCanvasElement;
  gpu: HTMLCanvasElement;
  where: HTMLElement;
}
const cards: Card[] = SCENES.map((scene) => {
  const card = document.createElement('section');
  card.className = 'sample';
  card.id = scene.id;
  const h = document.createElement('h2');
  h.innerHTML = `${scene.title} <a class="orig" href="https://www.cairographics.org/samples/#${scene.id}">Cairo's</a>`;
  card.append(h);
  const row = document.createElement('div');
  row.className = 'pair';
  const cpu = document.createElement('canvas');
  const gpu = document.createElement('canvas');
  for (const c of [cpu, gpu]) {
    c.width = SIZE;
    c.height = SIZE;
  }
  const cairo = document.createElement('pre');
  cairo.className = 'c';
  cairo.textContent = scene.cairo;
  row.append(cpu, gpu, cairo);
  card.append(row);
  const where = document.createElement('p');
  where.className = 'where';
  card.append(where);
  const details = document.createElement('details');
  details.className = 'pipeline';
  details.innerHTML = `<summary>The Nile that draws it</summary><pre class="nile"></pre>`;
  details.querySelector('pre')!.textContent = quoteNile(sources, scene.nile);
  card.append(details);
  grid.append(card);
  return { cpu, gpu, where };
});

// The GPU, on first use: one presenter over the two rasterizers, lowered
// here in the browser from the IR the bundle ships, drawing to each card's
// canvas in turn (all cards are the same size, so they share the plans).
let gpu: { device: GPUDevice; presenter: Presenter; format: GPUTextureFormat } | 'unavailable' | null = null;
async function ensureGpu() {
  if (gpu === null) {
    const device = await gpuDevice();
    if (!device) gpu = 'unavailable';
    else {
      const format = navigator.gpu.getPreferredCanvasFormat();
      const plans = { RasterizePixels: framePlan(RasterizePixelsIR, SIZE, SIZE), RasterizePixelsEvenOdd: framePlan(RasterizePixelsEvenOddIR, SIZE, SIZE) };
      gpu = { device, presenter: createPresenter(device, plans, { format }), format };
    }
  }
  return gpu === 'unavailable' ? null : gpu;
}

function drawCpu(i: number): void {
  const { cpu, gpu: gpuCanvas } = cards[i];
  const ctx = cpu.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  img.data.fill(255);
  SCENES[i].draw(new Sheet(nile, new CpuTarget(nile, img)), font, tiger);
  ctx.putImageData(img, 0, 0);
  showOnly(cpu, cpu, gpuCanvas);
}

async function draw(): Promise<void> {
  const g = modeEl.value === 'gpu' ? await ensureGpu() : null;
  if (modeEl.value === 'gpu' && !g) modeEl.value = 'cpu'; // the fallback when WebGPU is unavailable
  let onGpu = 0;
  const t0 = performance.now();
  SCENES.forEach((scene, i) => {
    const card = cards[i];
    if (!g) {
      drawCpu(i);
      card.where.textContent = '';
      return;
    }
    const batches: PathBatch[] = [];
    try {
      // The geometry runs first, all of it; a scene the presenter cannot
      // draw is found out before anything is submitted.
      scene.draw(new Sheet(nile, new GpuTarget(nile, SIZE, SIZE, batches)), font, tiger);
    } catch (e) {
      if (!(e instanceof CpuOnly)) throw e;
      drawCpu(i);
      card.where.textContent = `On the CPU: ${e.message}.`;
      return;
    }
    const { context } = configureCanvas(g.device, card.gpu)!;
    g.presenter.frame(batches, context.getCurrentTexture().createView());
    showOnly(card.gpu, card.cpu, card.gpu);
    card.where.textContent = `On the GPU: ${batches.length} path${batches.length === 1 ? '' : 's'}, each rasterized by ${[...new Set(batches.map((b) => b.plan))].join(' or ')} as WGSL lowered from its IR; the geometry is the same Nile on the CPU.`;
    onGpu++;
  });
  if (g) await g.device.queue.onSubmittedWorkDone();
  const ms = performance.now() - t0;
  perfEl.textContent = g
    ? `${SCENES.length} samples, ${onGpu} rasterized on the GPU and ${SCENES.length - onGpu} on the CPU, ${ms.toFixed(0)} ms in all.`
    : `${SCENES.length} samples, ${ms.toFixed(0)} ms in all, on the CPU (JavaScript compiled from Nile).`;
}

modeEl.addEventListener('change', () => void draw());
void draw();
