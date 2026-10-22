// Stroke demo: gezira's own stroke.nl — unmodified, higher-order (mid-stream
// ⇒, recursive generators, DupCat, Reverse) — compiled by Umgeni.

import { strokeOutline } from './src/vector/draw.js';
import { hexRGB, paintSpans } from './src/vector/spans.js';
import { nile } from './nl/vector.program';
import { quoteNile } from './src/quote.js';
import vectorNl from './nl/vector.nl';
import spansNl from './nl/spans.nl';
import strokeNl from '../gezira/stroke.nl';
import rasterizeNl from '../gezira/rasterize.nl';

(document.getElementById('nile') as HTMLElement).textContent = quoteNile(
  [vectorNl, spansNl, strokeNl, rasterizeNl],
  ['StrokeOutline', 'StrokeBezierPath', 'FillBeziers', 'Rasterize', 'PaintSpans'],
);


const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statsEl = document.getElementById('stats')!;
const W = canvas.width;
const H = canvas.height;
const I = [1, 0, 0, 1, 0, 0];

// A straight segment as a flat cubic (controls at 1/3, 2/3).
const lc = (p: number[], q: number[]): number[] => {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  return [p[0], p[1], p[0] + dx / 3, p[1] + dy / 3, p[0] + (2 * dx) / 3, p[1] + (2 * dy) / 3, q[0], q[1]];
};
const poly = (pts: number[][]): number[][] => pts.slice(0, -1).map((p, i) => lc(p, pts[i + 1]));

// Sample paths (device space), each one subpath.
const paths: number[][][] = [
  [[50, 110, 160, 10, 290, 200, 420, 90]], // one cubic: smooth offsets + caps
  poly([[50, 300], [140, 215], [230, 300], [320, 215], [410, 300]]), // zigzag: joins
  poly([[470, 50], [470, 150], [570, 150]]), // right angle
  poly([[490, 210], [530, 340], [570, 210]]), // sharp V: miter ratio ≈ 3.4, so the limit decides
  poly([[110, 360], [250, 360], [180, 420], [110, 360]]), // closed: a join where caps would be
];

const ui = { cap: -1, join: 'round', limit: 4, w: 22, outline: false };

function draw(): void {
  const img = ctx.createImageData(W, H);
  img.data.fill(255);
  const t0 = performance.now();
  const join = ui.join === 'round' ? -1 : ui.join === 'bevel' ? 1 : ui.limit;
  const outlines = paths.map((p) => strokeOutline(nile, I, ui.w, join, ui.cap, [p]));
  let spans = 0;
  for (const outline of outlines) {
    const s = nile.FillBeziers({ min: [0, 0], max: [W, H] }).run(outline);
    spans += s.length;
    paintSpans(img, nile, s, hexRGB('#2b6cb0'));
  }
  const ms = performance.now() - t0;
  ctx.putImageData(img, 0, 0);

  // Faint centrelines so the cap/join geometry is legible.
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  for (const path of paths) {
    ctx.beginPath();
    ctx.moveTo(path[0][0], path[0][1]);
    for (const c of path) ctx.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]);
    ctx.stroke();
  }
  // The outline itself: every quadratic gezira emitted, endpoints dotted.
  if (ui.outline) {
    ctx.strokeStyle = '#c53030';
    ctx.fillStyle = '#c53030';
    for (const [ax, ay, bx, by, cx, cy] of outlines.flat()) {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(bx, by, cx, cy);
      ctx.stroke();
      ctx.fillRect(ax - 1.5, ay - 1.5, 3, 3);
    }
  }
  const pieces = outlines.reduce((n, o) => n + o.length, 0);
  statsEl.textContent = `${pieces} outline beziers · ${spans.toLocaleString()} spans · ${ms.toFixed(1)} ms`;
}

function group(id: string, set: (v: string) => void): void {
  const el = document.getElementById(id)!;
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    el.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    set(btn.dataset.v!);
    draw();
  });
}
group('cap', (v) => (ui.cap = Number(v)));
group('join', (v) => {
  ui.join = v;
  (document.getElementById('limitrow') as HTMLElement).style.opacity = v === 'miter' ? '1' : '0.4';
});
const slider = (id: string, set: (v: number) => void) => {
  const el = document.getElementById(id) as HTMLInputElement;
  const out = document.getElementById(`${id}v`);
  el.addEventListener('input', () => {
    set(Number(el.value));
    if (out) out.textContent = el.value;
    draw();
  });
};
slider('w', (v) => (ui.w = v));
slider('limit', (v) => (ui.limit = v));
(document.getElementById('outline') as HTMLInputElement).addEventListener('change', (e) => {
  ui.outline = (e.target as HTMLInputElement).checked;
  draw();
});

draw();
