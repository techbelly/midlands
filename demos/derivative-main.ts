// Derivative: a circle looks for a letter by the derivative of the
// rasterizer that draws it. The Nile is nl/derivative.nl-lib; the page
// compiles it a second time here, in the browser, as its own derivative
// (umgeni's passes/derivative.ts), and src/derivative/fit.ts does the
// looking. Two shapes take the same steps side by side from the same
// circle, one led by roda's exact rasterizer and one by gezira's; the
// circle is set down at random within a pixel each time, and the page
// keeps count of how far each has got, since one of them ends somewhere
// else for every start.

import { compileLibrary, type CompiledLibrary } from '../umgeni/src/compile.js';
import { agreement, circle, coverageOf, createFit, fitted, type Fit, type Rasterizer } from './src/derivative/fit.js';
import { parseTrueType } from './src/text/ttf.js';
import { quoteNile } from './src/quote.js';
import { nile, sources } from './nl/derivative.nl-lib';
// Source Serif 4: SIL OFL 1.1 (fonts/OFL.txt)
import sourceSerif from './fonts/SourceSerif4.ttf';

const SIZE = 96;      // the picture, in pixels
const POINTS = 32;    // the shape's control points
const STEPS = 900;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

el('nile').textContent = quoteNile(sources, ['RasterizeBy', 'EdgeSums', 'RasterizeExact', 'RasterizeParallel', 'MonotoneBeziers', 'DecomposeExact', 'DecomposeBeziers', 'WindScan', 'SpansOf', 'EdgeCharge']);

// The same sources, as their own derivative: 2 directions a control point.
// WebAssembly if the browser will compile a module this size where it
// stands, else JavaScript.
function derivative(): { library: CompiledLibrary; note: string } {
  const t0 = performance.now();
  for (const target of ['wasm', 'js'] as const) {
    try {
      const library = compileLibrary(sources, { directions: 2 * POINTS, target });
      library.api.RasterizeExact().run([]); // a module that will not instantiate says so now
      return { library, note: `${2 * POINTS} directions, compiled in your browser in ${(performance.now() - t0).toFixed(0)} ms to ${target === 'wasm' ? 'WebAssembly' : 'JavaScript'}` };
    } catch (e) {
      if (target === 'js') throw e;
    }
  }
  throw new Error('unreachable');
}
const { library, note } = derivative();
const font = parseTrueType(sourceSerif as Uint8Array);

// --- the two shapes ---

interface Side {
  rasterizer: Rasterizer;
  canvas: HTMLCanvasElement;
  said: HTMLElement;
  fit: Fit | null;
  held: number | null; // the control point being dragged
  ends: number[];      // how far each start for this letter got, once settled
}
const sides: Side[] = [
  { rasterizer: 'RasterizeExact', canvas: el('exact'), said: el('exact-said'), fit: null, held: null, ends: [] },
  { rasterizer: 'RasterizeParallel', canvas: el('snapped'), said: el('snapped-said'), fit: null, held: null, ends: [] },
];
let target: Float64Array = new Float64Array(SIZE * SIZE);
let marked = 0;       // the control point the derivative panel is about
let down = false;     // …moving down, not right (shift)
let stepMs = 0;
let looking = '';     // the letter being looked for
let nudge = [0, 0];   // where within a pixel this start's circle was set down
let counted = true;   // this start's ends are in the tally (or it was touched, and will not be)

// How far a shape has got: its picture as the exact rasterizer draws it,
// whichever rasterizer led it, against the letter's.
const reached = (fit: Fit) => agreement(coverageOf(nile.RasterizeExact().run(fit.beziers()), SIZE), target);

function lookFor(ch: string): boolean {
  const glyph = font.glyphFor(ch);
  if (glyph.beziers.length === 0) return false;
  if (ch !== looking) for (const s of sides) s.ends = [];
  looking = ch;
  target = coverageOf(nile.RasterizeExact().run(fitted(glyph.beziers, SIZE)), SIZE);
  nudge = [Math.random() - 0.5, Math.random() - 0.5];
  counted = false;
  for (const s of sides) {
    s.fit = createFit(library, s.rasterizer, target, circle(POINTS, SIZE / 2 + nudge[0], SIZE / 2 + nudge[1], SIZE * 0.3), { size: SIZE, points: POINTS, steps: STEPS });
    s.held = null;
  }
  return true;
}

// --- drawing ---

const INK = [25, 25, 25], OVER = [244, 114, 48], UNDER = [132, 185, 243];
const LESS = [23, 87, 172], MORE = [220, 60, 61], NONE = [246, 246, 243];
const page = document.createElement('canvas');
page.width = page.height = SIZE;
const pageCtx = page.getContext('2d')!;

// A picture of SIZE × SIZE pixels, each drawn as a square.
function pixels(ctx: CanvasRenderingContext2D, colour: (i: number) => readonly number[]): void {
  const img = pageCtx.createImageData(SIZE, SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const [r, g, b] = colour(i);
    img.data[4 * i] = r;
    img.data[4 * i + 1] = g;
    img.data[4 * i + 2] = b;
    img.data[4 * i + 3] = 255;
  }
  pageCtx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(page, 0, 0, ctx.canvas.width, ctx.canvas.height);
}
const mix = (from: readonly number[], to: readonly number[], t: number) => from.map((v, k) => v + (to[k] - v) * Math.max(0, Math.min(1, t)));
const signed = (v: number, most: number) => (v < 0 ? mix(NONE, LESS, -v / most) : mix(NONE, MORE, v / most));

function outline(ctx: CanvasRenderingContext2D, fit: Fit, forces: boolean): void {
  const k = ctx.canvas.width / SIZE;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  fit.beziers().forEach(([ax, ay, bx, by, cx, cy], i) => {
    if (i === 0) ctx.moveTo(ax * k, ay * k);
    ctx.quadraticCurveTo(bx * k, by * k, cx * k, cy * k);
  });
  ctx.closePath();
  ctx.stroke();
  fit.points.forEach(([x, y], i) => {
    if (forces) {
      // Which way the point is being asked to go: against the slope.
      const gx = -fit.gradient[2 * i], gy = -fit.gradient[2 * i + 1];
      const long = Math.hypot(gx, gy);
      const show = Math.min(28, 9 * Math.sqrt(long));
      if (long > 1e-6) {
        ctx.strokeStyle = '#f2a600';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x * k, y * k);
        ctx.lineTo(x * k + (gx / long) * show, y * k + (gy / long) * show);
        ctx.stroke();
      }
    }
    ctx.beginPath();
    ctx.arc(x * k, y * k, i === marked ? 5 : 3, 0, 2 * Math.PI);
    ctx.fillStyle = i === marked ? '#f2a600' : '#fff';
    ctx.strokeStyle = '#191919';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
  });
}

function draw(): void {
  const forces = el<HTMLInputElement>('forces').checked;
  for (const s of sides) {
    const fit = s.fit!;
    const ctx = s.canvas.getContext('2d')!;
    const c = fit.coverage;
    pixels(ctx, (i) => {
      const both = Math.min(c[i], target[i]), over = c[i] - both, under = target[i] - both;
      return [0, 1, 2].map((k) => 255 - both * (255 - INK[k]) - over * (255 - OVER[k]) - under * (255 - UNDER[k]));
    });
    outline(ctx, fit, forces);
    s.said.textContent = `step ${Math.min(fit.step, STEPS)} of ${STEPS} · shape and letter agree over ${(100 * reached(fit)).toFixed(1)}%`;
  }
  // Once both have settled untouched, where they ended joins the count.
  if (!counted && sides.every((s) => s.fit!.settled)) {
    counted = true;
    for (const s of sides) s.ends.push(reached(s.fit!));
  }
  const range = (ends: number[]) => {
    const lo = (100 * Math.min(...ends)).toFixed(1), hi = (100 * Math.max(...ends)).toFixed(1);
    return lo === hi ? `${lo}%` : `${lo} to ${hi}%`;
  };
  const signedPx = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)}`;
  const starts = sides[0].ends.length;
  el('tally').textContent =
    `Both start from one circle, set down at random within a pixel: this time ${signedPx(nudge[0])}, ${signedPx(nudge[1])} px from the middle.` +
    (starts === 0 ? '' : ` Over ${starts === 1 ? 'the one start' : `the ${starts} starts`} for ${looking} that settled untouched: the exact rasterizer's shape ended at ${range(sides[0].ends)}, gezira's at ${range(sides[1].ends)}.`);
  // What the pipeline says of the shape on the left.
  const fit = sides[0].fit!;
  const ring = (ctx: CanvasRenderingContext2D) => {
    const k = ctx.canvas.width / SIZE, [x, y] = fit.points[marked];
    ctx.beginPath();
    ctx.arc(x * k, y * k, 5, 0, 2 * Math.PI);
    ctx.strokeStyle = '#f2a600';
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  const charge = new Float64Array(SIZE * SIZE);
  for (const [x, y, , h] of nile.EdgeCharge().run(fit.beziers())) {
    const px = Math.floor(x), py = Math.floor(y);
    if (px >= 0 && py >= 0 && px < SIZE && py < SIZE) charge[py * SIZE + px] = h;
  }
  const chargeCtx = el<HTMLCanvasElement>('charge').getContext('2d')!;
  pixels(chargeCtx, (i) => signed(charge[i], 1));
  ring(chargeCtx);
  const sumCtx = el<HTMLCanvasElement>('sum').getContext('2d')!;
  pixels(sumCtx, (i) => mix(NONE, INK, fit.coverage[i]));
  ring(sumCtx);
  // Each pixel's coverage as the marked point moves: two of the 64 slopes.
  const slope = [new Float64Array(SIZE * SIZE), new Float64Array(SIZE * SIZE)];
  let most = 1e-9;
  for (const s of fit.spans) {
    const y = Math.floor(s[1]);
    if (y < 0 || y >= SIZE) continue;
    for (let i = 0; i < s[3]; i++) {
      const x = Math.floor(s[0]) + i;
      if (x < 0 || x >= SIZE) continue;
      for (const c of [0, 1]) {
        const d = s[4 * (2 * marked + c + 1) + 2];
        slope[c][y * SIZE + x] = d;
        most = Math.max(most, Math.abs(d));
      }
    }
  }
  const movingCtx = el<HTMLCanvasElement>('moving').getContext('2d')!;
  pixels(movingCtx, (i) => signed(slope[down ? 1 : 0][i], most));
  ring(movingCtx);
  el('which').textContent = down ? 'down' : 'right';
  // The panel summed is how the shape's area changes, which the curve's own
  // formula also says; and the same sum by gezira's rasterizer, of this shape.
  const direction = 2 * marked + (down ? 1 : 0);
  const summed = (spans: number[][]) => spans.reduce((sum, s) => sum + s[4 * (direction + 1) + 2] * s[3], 0);
  const px = (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(4)}`;
  el('slope-said').textContent =
    `Summed over the picture, that is ${px(summed(fit.spans))} px² of area for each pixel the point moves ${down ? 'down' : 'right'}. ` +
    `The curve's own formula says ${px(fit.areaSlope(marked, down))}. ` +
    `The same sum by gezira's rasterizer, for this shape: ${px(summed(library.api.RasterizeParallel().run(fit.tokens())))}.`;
  el('perf').textContent = `The rasterizer as its own derivative: ${note} · ${stepMs.toFixed(1)} ms a step for each shape`;
  el('stats').textContent = `${POINTS} control points, ${POINTS} beziers · ${SIZE} × ${SIZE} px · each token ${1 + 2 * POINTS} times as wide as the rasterizer's own`;
}

// --- the loop: a few steps a frame until both have settled ---

let scheduled = false;
function frame(): void {
  scheduled = false;
  let busy = false;
  const t0 = performance.now();
  let steps = 0;
  try {
    for (const s of sides) {
      const fit = s.fit!;
      if (fit.settled || s.held !== null) continue;
      for (let i = 0; i < 3 && !fit.settled; i++) {
        fit.advance();
        steps++;
      }
      busy ||= !fit.settled;
    }
    if (steps > 0) stepMs = (performance.now() - t0) / steps;
    draw();
  } catch (e) {
    // Nothing here should throw; if something does, say so and stop, where
    // a loop that died quietly would look like a shape that had settled.
    el('perf').textContent = `Stopped: ${String((e as Error).message ?? e)}`;
    el('perf').className = 'perf err';
    return;
  }
  if (busy) schedule();
  else if (el<HTMLInputElement>('repeat').checked && sides.every((s) => s.held === null)) setTimeout(start, 700);
}
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(frame);
}

// --- the interface ---

const letter = el<HTMLInputElement>('letter');
function start(): void {
  const ch = [...letter.value].pop();
  // A character with no outline (a space) is not something to look for.
  letter.value = ch && lookFor(ch) ? ch : looking;
  schedule();
}
letter.addEventListener('input', start);
el('again').addEventListener('click', start);
el('forces').addEventListener('change', schedule);
el('repeat').addEventListener('change', schedule);
for (const ch of ['S', 'C', 'G', '5', 'L', 'r', '&', '?']) {
  const b = document.createElement('button');
  b.textContent = ch;
  b.addEventListener('click', () => {
    letter.value = ch;
    start();
  });
  el('quick').append(b, ' ');
}

// Pointing marks a control point; dragging takes it somewhere, and letting
// go sets the shape looking again from there.
for (const s of sides) {
  // Where the pointer is in the picture, kept to the picture: a captured
  // pointer can be anywhere on the screen.
  const where = (e: PointerEvent): number[] => {
    const r = s.canvas.getBoundingClientRect();
    const within = (v: number) => Math.max(0, Math.min(SIZE, v));
    return [within(((e.clientX - r.left) / r.width) * SIZE), within(((e.clientY - r.top) / r.height) * SIZE)];
  };
  const nearest = (at: number[]): number | null => {
    let best: number | null = null, d = 4; // pixels of the picture
    s.fit!.points.forEach((p, i) => {
      const far = Math.hypot(p[0] - at[0], p[1] - at[1]);
      if (far < d) (d = far, best = i);
    });
    return best;
  };
  s.canvas.addEventListener('pointermove', (e) => {
    down = e.shiftKey;
    if (s.held !== null) {
      s.fit!.move(s.held, where(e));
    } else {
      const i = nearest(where(e));
      if (i !== null) marked = i;
    }
    schedule();
  });
  s.canvas.addEventListener('pointerdown', (e) => {
    const i = nearest(where(e));
    if (i === null) return;
    s.held = marked = i;
    counted = true; // a start that was helped is not one to count
    s.canvas.setPointerCapture(e.pointerId);
  });
  const release = () => {
    if (s.held === null) return;
    s.held = null;
    s.fit!.rekindle();
    schedule();
  };
  s.canvas.addEventListener('pointerup', release);
  s.canvas.addEventListener('pointercancel', release);
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift' && !down) (down = true, schedule());
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') (down = false, schedule());
});

start();
