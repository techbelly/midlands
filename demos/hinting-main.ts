// Hinting: a paragraph of small text finds the pixel grid by the derivative
// of the rasterizer that draws it. The Nile is nl/hinting.nl-lib, which is
// the rasterizers and nothing of the page's own; the page compiles it a
// second time here, in the browser, as its own derivative (umgeni's
// passes/derivative.ts), a direction to each knot a letter lies among of a
// warp of each axis of its line, and src/hinting/hint.ts slides the knots
// to make the picture less grey.

import { compileLibrary, type CompiledLibrary } from '../umgeni/src/compile.js';
import { createHint, directionsFor, grey, ink, setLines, type Hint, type Line } from './src/hinting/hint.js';
import { parseTrueType } from './src/text/ttf.js';
import { quoteNile } from './src/quote.js';
import { sources } from './nl/hinting.nl-lib';
// Source Serif 4: SIL OFL 1.1 (fonts/OFL.txt)
import sourceSerif from './fonts/SourceSerif4.ttf';

const WIDTH = 380;    // the paragraph's measure, in pixels
const STEPS = 300;
const LENS = 64;      // how many pixels across the large pictures show
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

el('nile').textContent = quoteNile(sources, ['RasterizeExact', 'RasterizeBy', 'EdgeSums', 'MonotoneBeziers', 'DecomposeExact', 'WindScan', 'SpansOf']);

// The same sources as their own derivative, in enough directions for the
// knots any one letter lies among: compiled when first wanted, and kept.
interface Compiled { library: CompiledLibrary; directions: number; note: string }
const compiled = new Map<number, Compiled>();
function derivative(n: number): Compiled {
  const directions = 12 * Math.ceil(n / 12);
  const have = compiled.get(directions);
  if (have) return have;
  const t0 = performance.now();
  for (const target of ['wasm', 'js'] as const) {
    try {
      const library = compileLibrary(sources, { directions, target });
      library.api.RasterizeExact().run([]); // a module that will not instantiate says so now
      const made = { library, directions, note: `${directions} directions, compiled in your browser in ${(performance.now() - t0).toFixed(0)} ms to ${target === 'wasm' ? 'WebAssembly' : 'JavaScript'}` };
      compiled.set(directions, made);
      return made;
    } catch (e) {
      if (target === 'js') throw e;
    }
  }
  throw new Error('unreachable');
}
const font = parseTrueType(sourceSerif as Uint8Array);

// --- the paragraph, and its looking ---

let lines: Line[] = [];
let hints: Hint[] = [];
let using: Compiled;
let at = [0.37, 0.41];   // where within a pixel the first line is set down
let stepMs = 0;
let next = 0;            // the line whose turn it is
let lens = { line: 0, from: 0 };

const text = el<HTMLTextAreaElement>('text');
const size = el<HTMLInputElement>('size');
const keep = el<HTMLInputElement>('keep');
const even = el<HTMLInputElement>('even');
const times = el<HTMLSelectElement>('times');
times.value = String(Math.max(1, Math.min(4, Math.round(window.devicePixelRatio || 1))));

function start(): void {
  const px = Number(size.value);
  lines = setLines(font, text.value, px, at, WIDTH);
  using = derivative(directionsFor(lines));
  hints = lines.map((line) => createHint(using.library, using.directions, line, { keep: Number(keep.value), even: Number(even.value), steps: STEPS }));
  next = 0;
  const looked = Math.min(lens.line, Math.max(0, lines.length - 1)), there = lines[looked];
  lens = { line: looked, from: there ? Math.max(0, Math.min(lens.from, there.width - Math.min(LENS, there.width))) : 0 };
  el('size-said').textContent = `${px} px`;
  el('keep-said').textContent = Number(keep.value) === 0 ? 'not at all' : keep.value;
  el('even-said').textContent = Number(even.value) === 0 ? 'not at all' : even.value;
  schedule();
}

// --- drawing ---

const scratch = document.createElement('canvas');
const scratchCtx = scratch.getContext('2d')!;

// A picture, a canvas pixel to each of its own.
function pixels(c: Float64Array, width: number, height: number): HTMLCanvasElement {
  scratch.width = Math.max(1, width);
  scratch.height = Math.max(1, height);
  const img = scratchCtx.createImageData(scratch.width, scratch.height);
  for (let i = 0; i < c.length; i++) {
    const v = Math.round(255 - 230 * Math.max(0, Math.min(1, c[i])));
    img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = v;
    img.data[4 * i + 3] = 255;
  }
  scratchCtx.putImageData(img, 0, 0);
  return scratch;
}

// The page: every line's picture where its rows are.
function paragraph(canvas: HTMLCanvasElement, of: (hint: Hint) => Float64Array): void {
  const width = Math.max(WIDTH, ...lines.map((l) => l.width));
  const height = Math.max(1, ...lines.map((l) => l.row + l.height));
  const c = new Float64Array(width * height);
  lines.forEach((line, i) => {
    const picture = of(hints[i]);
    for (let y = 0; y < line.height; y++) {
      for (let x = 0; x < line.width; x++) {
        const v = picture[y * line.width + x];
        if (v > 0) c[(line.row + y) * width + x] = Math.max(c[(line.row + y) * width + x], v);
      }
    }
  });
  // Each pixel of the picture as so many of the screen's across.
  const ratio = window.devicePixelRatio || 1, by = Number(times.value);
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${(width * by) / ratio}px`;
  canvas.style.height = `${(height * by) / ratio}px`;
  canvas.getContext('2d')!.drawImage(pixels(c, width, height), 0, 0);
  // Where the large pictures are looking.
  const line = lines[lens.line], mark = canvas.nextElementSibling as HTMLElement;
  if (!line) return void (mark.style.display = 'none');
  const k = by / ratio;
  mark.style.display = 'block';
  mark.style.left = `${lens.from * k}px`;
  mark.style.top = `${line.row * k}px`;
  mark.style.width = `${Math.min(LENS, line.width) * k}px`;
  mark.style.height = `${line.height * k}px`;
}

// Part of one line, large, with the pixel grid, the outlines, and (for the
// picture that has moved) how far each knot there has slid.
function large(canvas: HTMLCanvasElement, c: Float64Array, line: Line, beziers: number[][], colour: string, hint: Hint | null): void {
  const k = 26, across = Math.min(LENS, line.width), from = lens.from;
  canvas.width = across * k;
  canvas.height = line.height * k;
  canvas.style.maxWidth = `${across * 13.4}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(pixels(c, line.width, line.height), from, 0, across, line.height, 0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(120, 130, 150, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= across; x++) (ctx.moveTo(x * k + 0.5, 0), ctx.lineTo(x * k + 0.5, canvas.height));
  for (let y = 0; y <= line.height; y++) (ctx.moveTo(0, y * k + 0.5), ctx.lineTo(canvas.width, y * k + 0.5));
  ctx.stroke();
  if (el<HTMLInputElement>('outlines').checked) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (const [ax, ay, bx, by, cx, cy] of beziers) {
      if (Math.max(ax, bx, cx) < from || Math.min(ax, bx, cx) > from + across) continue;
      ctx.moveTo((ax - from) * k, ay * k);
      ctx.quadraticCurveTo((bx - from) * k, by * k, (cx - from) * k, cy * k);
    }
    ctx.stroke();
  }
  if (!hint) return;
  // Each knot's slide, along the top and down the left: a stroke from its
  // pixel line to where it has gone.
  ctx.strokeStyle = ctx.fillStyle = colour;
  ctx.lineWidth = 3;
  const stroke = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x1, y1, 4, 0, 2 * Math.PI);
    ctx.fill();
  };
  for (let i = from; i <= from + across; i++) {
    const s = hint.slide[i];
    if (Math.abs(s) >= 0.02) stroke((i - from) * k, k / 2, (i - from + s) * k, k / 2);
  }
  for (let i = 0; i <= line.height; i++) {
    const s = hint.slide[hint.across + i];
    if (Math.abs(s) >= 0.02) stroke(k / 2, i * k, k / 2, (i + s) * k);
  }
}

function draw(): void {
  paragraph(el('before'), (h) => h.before);
  paragraph(el('after'), (h) => h.coverage);
  const sum = (f: (h: Hint) => number) => hints.reduce((total, h) => total + f(h), 0);
  const grey0 = sum((h) => grey(h.before)), ink0 = sum((h) => ink(h.before));
  const greyNow = sum((h) => h.grey), inkNow = sum((h) => ink(h.coverage));
  const step = Math.min(STEPS, ...hints.map((h) => h.step));
  el('before-said').textContent = `grey ${grey0.toFixed(0)} · ink ${ink0.toFixed(0)} px²`;
  el('after-said').textContent = hints.length === 0 ? '' :
    `step ${step} of ${STEPS} · grey ${greyNow.toFixed(0)}, ${(100 * (1 - greyNow / (grey0 || 1))).toFixed(0)}% less · ` +
    `ink ${(100 * inkNow / (ink0 || 1)).toFixed(0)}% of what it was · ` +
    `the furthest knot has slid ${Math.max(0, ...hints.map((h) => Math.max(...h.slide.map(Math.abs)))).toFixed(2)} px`;
  const line = lines[lens.line], hint = hints[lens.line];
  for (const id of ['before-large', 'after-large']) el(id).style.display = line ? 'block' : 'none';
  if (line) {
    large(el('before-large'), hint.before, line, line.letters.flat(), 'rgba(23, 87, 172, 0.8)', null);
    large(el('after-large'), hint.coverage, line, hint.beziers(), 'rgba(226, 92, 20, 0.9)', hint);
  }
  const letters = lines.reduce((n, l) => n + l.letters.length, 0), beziers = lines.reduce((n, l) => n + l.letters.reduce((m, b) => m + b.length, 0), 0);
  el('perf').textContent = `The rasterizer as its own derivative: ${using.note} · ${stepMs.toFixed(1)} ms for a step of every line`;
  el('stats').textContent =
    `${lines.length} lines at ${size.value} px, ${letters} letters, ${beziers} beziers · ${lines.reduce((n, l) => n + l.width + l.height + 2, 0)} knots, ` +
    `of which no letter lies among more than ${directionsFor(lines)} · set down ${at[0].toFixed(2)}, ${at[1].toFixed(2)} px off the grid`;
}

// --- the loop: each line a step in turn, as many as a frame has time for ---

let scheduled = false;
function frame(): void {
  scheduled = false;
  try {
    const t0 = performance.now();
    let stepped = 0;
    const waiting = () => hints.some((h) => !h.settled);
    while (waiting() && (stepped < 1 || performance.now() - t0 < 24)) {
      const hint = hints[next];
      next = (next + 1) % hints.length;
      if (hint.settled) continue;
      hint.advance();
      stepped++;
    }
    if (stepped > 0) stepMs = ((performance.now() - t0) / stepped) * hints.length;
    draw();
  } catch (e) {
    // Nothing here should throw; if something does, say so and stop, where
    // a loop that died quietly would look like a paragraph that had settled.
    el('perf').textContent = `Stopped: ${String((e as Error).message ?? e)}`;
    el('perf').className = 'perf err';
    return;
  }
  if (hints.some((h) => !h.settled)) schedule();
}
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(frame);
}

// --- the interface ---

for (const input of [text, size, keep, even]) input.addEventListener('input', start);
el('outlines').addEventListener('change', schedule);
times.addEventListener('change', schedule);
el('again').addEventListener('click', () => {
  at = [Math.random(), Math.random()];
  start();
});
el('loose').addEventListener('click', () => {
  keep.value = even.value = '0';
  start();
});
el('held').addEventListener('click', () => {
  keep.value = '4';
  even.value = '2';
  start();
});

// Pointing at either paragraph turns the large pictures to what is there.
for (const id of ['before', 'after']) {
  const canvas = el<HTMLCanvasElement>(id);
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * canvas.width, y = ((e.clientY - r.top) / r.height) * canvas.height;
    let best = 0, far = Infinity;
    lines.forEach((line, i) => {
      const d = Math.abs(y - (line.row + line.height / 2));
      if (d < far) (far = d, best = i);
    });
    const line = lines[best];
    if (!line) return;
    lens = { line: best, from: Math.max(0, Math.min(Math.round(x - LENS / 2), line.width - Math.min(LENS, line.width))) };
    schedule();
  });
}

start();
