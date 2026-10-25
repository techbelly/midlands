// The Cairo samples, drawn by Nile: each of Cairo's nineteen samples beside
// the same picture made by compiled Nile, with the Nile that does it.

import { nile } from './nl/samples.nl-lib';
import { parseTrueType } from './src/text/ttf.js';
import { Sheet } from './src/samples/draw.js';
import { SCENES } from './src/samples/scenes.js';
import { parseSvg } from './src/vector/svg.js';
import { drawTiger, fitView } from './src/vector/tiger.js';
import { quoteNile } from './src/quote.js';
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
import vectorNl from './nl/vector.nl';
import spansNl from './nl/spans.nl';
import rasterizeParallelNl from '../umgeni/nl/rasterize-parallel.nl';
import evenoddNl from './nl/evenodd.nl';
import dashNl from './nl/dash.nl';
import clipNl from './nl/clip.nl';
import samplesNl from './nl/samples.nl';

const SOURCES = [typesNl, bezierNl, strokeNl, rasterizeNl, textureNl, gradientNl, filterNl, vectorNl, spansNl, rasterizeParallelNl, evenoddNl, dashNl, clipNl, samplesNl];
const font = parseTrueType(sourceSerif);
// The picture the image samples use, where Cairo's use a photograph: the
// tiger, drawn by the same Nile at 256 × 256.
const tiger = { width: 256, height: 256, data: new Uint8ClampedArray(256 * 256 * 4).fill(255) };
drawTiger(tiger, parseSvg(tigerSvg, nile), fitView(256, 256), nile);
const grid = document.getElementById('samples')!;
let totalMs = 0;

for (const scene of SCENES) {
  const card = document.createElement('section');
  card.className = 'sample';
  card.id = scene.id;
  const h = document.createElement('h2');
  h.innerHTML = `${scene.title} <a class="orig" href="https://www.cairographics.org/samples/#${scene.id}">Cairo's</a>`;
  card.append(h);

  const row = document.createElement('div');
  row.className = 'pair';
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const cairo = document.createElement('pre');
  cairo.className = 'c';
  cairo.textContent = scene.cairo;
  row.append(canvas, cairo);
  card.append(row);

  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(256, 256);
  img.data.fill(255);
  const t0 = performance.now();
  scene.draw(new Sheet(nile, img), font, tiger);
  totalMs += performance.now() - t0;
  ctx.putImageData(img, 0, 0);
  const details = document.createElement('details');
  details.className = 'pipeline';
  details.innerHTML = `<summary>The Nile that draws it</summary><pre class="nile"></pre>`;
  details.querySelector('pre')!.textContent = quoteNile(SOURCES, scene.nile);
  card.append(details);
  grid.append(card);
}
document.getElementById('stats')!.textContent = `${SCENES.length} samples, ${totalMs.toFixed(0)} ms in all, on the CPU (JavaScript compiled from Nile).`;
