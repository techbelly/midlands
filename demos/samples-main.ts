// The Cairo samples, drawn by Nile: each of Cairo's nineteen samples beside
// the same picture made by compiled Nile, with the Nile that does it. On the
// CPU, the Nile compiled to JavaScript draws every card; on the GPU, the
// cards the presenter can draw (fills and strokes, under either rule) are
// rasterized by RasterizePixels lowered from its IR, and the rest say why
// they are drawn on the CPU.

import { nile, RasterizePixelsIR, RasterizePixelsEvenOddIR } from './nl/samples.nl-lib';
import { parseTrueType } from './src/text/ttf.js';
import { CpuOnly, CpuTarget, GpuTarget, Sheet } from './src/samples/draw.js';
import { SCENES } from './src/samples/scenes.js';
import { parseSvg } from './src/vector/svg.js';
import { drawTiger, fitView } from './src/vector/tiger.js';
import { quoteNile } from './src/quote.js';
import { createPresenter, type PathBatch, type Presenter } from '../umgeni/src/gpu/present.js';
import { lowerPipeline } from '../umgeni/src/gpu/lower.js';
import { coverageSink } from '../umgeni/src/gpu/execute.js';
import { requestDevice } from '../umgeni/src/gpu/device.js';
import tigerSvg from './tiger.svg';
// Source Serif 4: SIL OFL 1.1 (fonts/OFL.txt). Cairo's samples ask for Sans.
import sourceSerif from './fonts/SourceSerif4.ttf';
import typesNl from '../gezira/types.nl';
import bezierNl from '../gezira/bezier.nl';
import strokeNl from '../gezira/stroke.nl';
import rasterizeNl from '../gezira/rasterize.nl';
import textureNl from '../gezira/texture.nl';
import gradientNl from '../gezira/gradient.nl';
import filterNl from '../gezira/filter.nl';
import vectorNl from '../roda/vector.nl';
import spansNl from '../roda/spans.nl';
import rasterizeParallelNl from '../roda/rasterize-parallel.nl';
import evenoddNl from '../roda/evenodd.nl';
import dashNl from '../roda/dash.nl';
import clipNl from '../roda/clip.nl';
import imageNl from '../roda/image.nl';
import samplesNl from './nl/samples.nl';
import patchNl from '../roda/patch.nl';

const SOURCES = [typesNl, bezierNl, strokeNl, rasterizeNl, textureNl, gradientNl, filterNl, vectorNl, spansNl, rasterizeParallelNl, evenoddNl, dashNl, clipNl, patchNl, imageNl, samplesNl];
const SIZE = 256;
const font = parseTrueType(sourceSerif);
// The picture the image samples use, where Cairo's use a photograph: the
// tiger, drawn by the same Nile at 256 × 256.
const tiger = { width: SIZE, height: SIZE, data: new Uint8ClampedArray(SIZE * SIZE * 4).fill(255) };
drawTiger(tiger, parseSvg(tigerSvg, nile), fitView(SIZE, SIZE), nile);

const modeEl = document.getElementById('mode') as HTMLSelectElement;
const statsEl = document.getElementById('stats')!;
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
  details.querySelector('pre')!.textContent = quoteNile(SOURCES, scene.nile);
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
    const device = await requestDevice();
    if (!device) gpu = 'unavailable';
    else {
      const format = navigator.gpu.getPreferredCanvasFormat();
      const opts = { extent: [SIZE, SIZE], sink: coverageSink };
      const plans = { RasterizePixels: lowerPipeline(RasterizePixelsIR, opts), RasterizePixelsEvenOdd: lowerPipeline(RasterizePixelsEvenOddIR, opts) };
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
  cpu.style.display = '';
  gpuCanvas.style.display = 'none';
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
    const context = card.gpu.getContext('webgpu')!;
    context.configure({ device: g.device, format: g.format, alphaMode: 'opaque' });
    g.presenter.frame(batches, context.getCurrentTexture().createView());
    card.cpu.style.display = 'none';
    card.gpu.style.display = '';
    card.where.textContent = `On the GPU: ${batches.length} path${batches.length === 1 ? '' : 's'}, each rasterized by ${[...new Set(batches.map((b) => b.plan))].join(' or ')} as WGSL lowered from its IR; the geometry is the same Nile on the CPU.`;
    onGpu++;
  });
  if (g) await g.device.queue.onSubmittedWorkDone();
  const ms = performance.now() - t0;
  statsEl.textContent = g
    ? `${SCENES.length} samples, ${onGpu} rasterized on the GPU and ${SCENES.length - onGpu} on the CPU, ${ms.toFixed(0)} ms in all.`
    : `${SCENES.length} samples, ${ms.toFixed(0)} ms in all, on the CPU (JavaScript compiled from Nile).`;
}

modeEl.addEventListener('change', () => void draw());
void draw();
