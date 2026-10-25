// The Cairo samples' Nile (nl/evenodd.nl, …), checked headless.
import { describe, expect, it } from 'vitest';
import { compileLibraryFile, librarySources, read } from '../src/sources.js';
import { compileLibrary } from '../../umgeni/src/compile.js';
import type { Api } from '../src/vector/draw.js';
import { lowerPipeline } from '../../umgeni/src/gpu/lower.js';
import { coverageSink } from '../../umgeni/src/gpu/execute.js';
import type { FusedIR } from '../../umgeni/src/ir.js';

const library = compileLibraryFile('demos/nl/vector.nl-lib');
const nile: Api = library.api;

// A square as flat beziers, clockwise or anticlockwise.
const square = (x0: number, y0: number, x1: number, y1: number, cw = true): number[][] => {
  const pts = cw ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];
  return pts.map((p, i) => {
    const q = pts[(i + 1) % 4];
    return [p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, q[0], q[1]];
  });
};
// Coverage at pixel (x, y) from a span list.
const coverageAt = (spans: number[][], x: number, y: number): number => {
  let c = 0;
  for (const [sx, sy, sc, sl] of spans) if (Math.floor(sy) === y && Math.floor(sx) <= x && x < Math.floor(sx) + sl) c += sc;
  return c;
};

describe('the even-odd rule (nl/evenodd.nl)', () => {
  it('compiles, and lowers nothing unsupported', () => {
    expect(library.unsupported).toEqual([]);
    expect(library.registry.has('RasterizeEvenOdd')).toBe(true);
  });
  it('leaves a doubly-wound region empty where non-zero winding fills it', () => {
    const twice = [...square(2, 2, 12, 12), ...square(4, 4, 10, 10)]; // same direction: winding 2 inside
    const nonzero = nile.RasterizeParallel().run(twice);
    const evenodd = nile.RasterizeEvenOdd().run(twice);
    expect(coverageAt(nonzero, 7, 7)).toBeCloseTo(1, 9);
    expect(coverageAt(evenodd, 7, 7)).toBeCloseTo(0, 9);
    // The ring between the squares is filled under both rules.
    expect(coverageAt(nonzero, 3, 7)).toBeCloseTo(1, 9);
    expect(coverageAt(evenodd, 3, 7)).toBeCloseTo(1, 9);
  });
  it('lowers to the GPU by its declarations, like RasterizeParallel', () => {
    const ir = library.ir.processes.find((p) => p.name === 'RasterizeEvenOdd') as FusedIR;
    const plan = lowerPipeline(ir, { extent: [16, 16], sink: coverageSink });
    expect(plan.passes.length).toBe(2);
  });
  it('agrees with non-zero winding on a simple shape', () => {
    const one = square(1, 1, 9, 9);
    expect(nile.RasterizeEvenOdd().run(one)).toEqual(nile.RasterizeParallel().run(one));
  });
});

// A straight segment as a flat bezier, and a flat cubic.
const seg = (x0: number, y0: number, x1: number, y1: number): number[] => [x0, y0, (x0 + x1) / 2, (y0 + y1) / 2, x1, y1];
const cubic = (x0: number, y0: number, x1: number, y1: number): number[] =>
  [x0, y0, x0 + (x1 - x0) / 3, y0 + (y1 - y0) / 3, x0 + (2 * (x1 - x0)) / 3, y0 + (2 * (y1 - y0)) / 3, x1, y1];
const chord = (b: number[]) => Math.hypot(b[4] - b[0], b[5] - b[1]);
const I = [1, 0, 0, 1, 0, 0];

describe('dashes (nl/dash.nl)', () => {
  it('compiles: DashBeziers and the capped stroker', () => {
    expect(library.unsupported).toEqual([]);
    for (const n of ['DashBeziers', 'StrokePieces', 'DashedStroke']) expect(library.registry.has(n), n).toBe(true);
  });
  it('cuts a line into dashes of the pattern, carrying the phase across beziers', () => {
    // 100 long, on 20 off 10: dashes at 0–20, 30–50, 60–80, 90–100.
    const dashes = nile.DashBeziers({ on1: 20, off1: 10, on2: 20, off2: 10, phase: 0 }).run([seg(0, 0, 60, 0), seg(60, 0, 100, 0)]);
    const starts = dashes.map((b) => b[0]);
    expect(starts).toEqual([0, 30, 60, 90]);
    expect(dashes.reduce((n, b) => n + chord(b), 0)).toBeCloseTo(70, 9);
    // A phase moves the pattern back along the path.
    const shifted = nile.DashBeziers({ on1: 20, off1: 10, on2: 20, off2: 10, phase: 25 }).run([seg(0, 0, 100, 0)]);
    expect(shifted.map((b) => b[0])).toEqual([5, 35, 65, 95]);
    // Cairo's dash sample: 50 on, 10 off, 10 on, 10 off, offset -50.
    const four = nile.DashBeziers({ on1: 50, off1: 10, on2: 10, off2: 10, phase: -50 }).run([seg(0, 0, 160, 0)]);
    expect(four.map((b) => [b[0], b[4]])).toEqual([[0, 20], [30, 40], [50, 100], [110, 120], [130, 160]]); // −50 into an 80-long pattern is 30 in: 20 of the first dash remain
  });
  it('strokes disconnected pieces with caps at every end, nothing between', () => {
    const w = 4;
    const pieces = [seg(2, 10, 20, 10), seg(40, 10, 58, 10)];
    const spans = nile.FillBeziers({ min: [0, 0], max: [64, 20] }).run(nile.StrokePieces({ w, l: 4, c: 0 }).run(pieces));
    expect(coverageAt(spans, 10, 9)).toBeCloseTo(1, 9); // on the first piece
    expect(coverageAt(spans, 50, 9)).toBeCloseTo(1, 9); // on the second
    expect(coverageAt(spans, 30, 9)).toBeCloseTo(0, 9); // the gap
    expect(coverageAt(spans, 10, 5)).toBeCloseTo(0, 9); // outside the width
    // Square caps extend each piece by half the width.
    const square = nile.FillBeziers({ min: [0, 0], max: [64, 20] }).run(nile.StrokePieces({ w, l: 4, c: 1 }).run(pieces));
    expect(coverageAt(square, 21, 9)).toBeCloseTo(1, 9);
    expect(coverageAt(spans, 21, 9)).toBeCloseTo(0, 9);
  });
  it('is gezira\'s stroker on a connected path', () => {
    const zigzag = [seg(5, 5, 25, 30), seg(25, 30, 45, 5), seg(45, 5, 60, 28)];
    const a = nile.StrokePieces({ w: 6, l: 4, c: -1 }).run(zigzag);
    const b = nile.StrokeBezierPath({ w: 6, l: 4, c: -1 }).run(zigzag);
    expect(a).toEqual(b);
  });
  it('dashes a cubic path end to end', () => {
    const outline = nile.DashedStroke({ M: I, w: 3, l: 4, c: 0, on1: 10, off1: 5, on2: 10, off2: 5, phase: 0 }).run([cubic(0, 10, 90, 10)]);
    const spans = nile.FillBeziers({ min: [0, 0], max: [100, 20] }).run(outline);
    expect(coverageAt(spans, 5, 9)).toBeCloseTo(1, 9);
    expect(coverageAt(spans, 12, 9)).toBeCloseTo(0, 9);
    expect(coverageAt(spans, 20, 9)).toBeCloseTo(1, 9);
  });
});

const pixelAt = (pts: number[][], x: number, y: number): number | null => {
  const t = pts.find((p) => Math.floor(p[0]) === x && Math.floor(p[1]) === y);
  return t ? t[2] : null;
};

describe('clipping and masking (nl/clip.nl)', () => {
  it('keeps the pixels both the shape and the clip cover, with the product of their coverages', () => {
    const shape = nile.RasterizeParallel().run(square(0, 0, 10, 10));
    const clip = nile.RasterizeParallel().run(square(5, 5, 15, 15));
    const pts = nile.Intersect().run([...shape, ...clip]);
    expect(pixelAt(pts, 7, 7)).toBeCloseTo(1, 9); // in both
    expect(pixelAt(pts, 2, 2)).toBeNull(); // shape only
    expect(pixelAt(pts, 12, 12)).toBeNull(); // clip only
    expect(pts.length).toBe(25);
    // A half-covered clip edge halves the shape's coverage.
    const half = nile.RasterizeParallel().run(square(5, 5, 15, 9.5));
    const edge = nile.Intersect().run([...shape, ...half]);
    expect(pixelAt(edge, 7, 9)).toBeCloseTo(0.5, 9);
  });
  it('masks coverage by a texture alpha', () => {
    // MaskSpans takes a texture, so it is instantiated where it is used.
    const fade = 'Fade : CoverageSpan >> CoveragePoint\n    ⇒ MaskSpans (UniformColor ((0.5, 1, 1, 1)))\n';
    const lib = compileLibrary([...librarySources('demos/nl/vector.nl-lib').map((f) => read(f)), fade]);
    expect(lib.unsupported).toEqual([]);
    const pts = lib.api.Fade().run(nile.RasterizeParallel().run(square(0, 0, 4, 4)));
    expect(pts.length).toBe(16);
    for (const q of pts) expect(q[2]).toBeCloseTo(0.5, 9);
  });
});

// --- the samples page, headless -----------------------------------------------
import { readFileSync } from 'node:fs';
import { parseTrueType } from '../src/text/ttf.js';
import { Sheet } from '../src/samples/draw.js';
import { SCENES } from '../src/samples/scenes.js';
import { path } from '../src/samples/path.js';
import { parseSvg } from '../src/vector/svg.js';
import { drawTiger, fitView } from '../src/vector/tiger.js';

const samples = compileLibraryFile('demos/nl/samples.nl-lib');
const font = parseTrueType(readFileSync(new URL('../fonts/SourceSerif4.ttf', import.meta.url)));
const page = () => ({ width: 256, height: 256, data: new Uint8ClampedArray(256 * 256 * 4).fill(255) });
const px = (img: { data: Uint8ClampedArray }, x: number, y: number) => [...img.data.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 3)];
const WHITE = [255, 255, 255];
// The picture the image samples use: the tiger, drawn by the same Nile.
const tiger = page();
drawTiger(tiger, parseSvg(read('demos/tiger.svg'), samples.api), fitView(256, 256), samples.api);
const render = (id: string) => {
  const scene = SCENES.find((s) => s.id === id)!;
  const img = page();
  scene.draw(new Sheet(samples.api, img), font, tiger);
  return img;
};

describe('the Cairo samples, drawn by Nile', () => {
  it('the samples library compiles with nothing unsupported', () => {
    expect(samples.unsupported).toEqual([]);
  });
  it('builds paths as Cairo does: arcs join the current point, close_path closes', () => {
    const p = path().moveTo(0, 0).arc(10, 0, 10, Math.PI, 2 * Math.PI).closePath().build();
    expect(p.subpaths.length).toBe(1);
    const first = p.subpaths[0][0];
    expect([first[0], first[1]]).toEqual([0, 0]); // the arc starts at the current point: no line needed
    const last = p.subpaths[0][p.subpaths[0].length - 1];
    expect([last[6], last[7]]).toEqual([0, 0]); // closed back to the start
    expect(path().rectangle(1, 2, 3, 4).build().cubics.length).toBe(4);
  });
  it('draws every sample', () => {
    for (const scene of SCENES) {
      const img = render(scene.id);
      let inked = 0;
      for (let i = 0; i < 256 * 256; i++) if (img.data[i * 4] !== 255 || img.data[i * 4 + 1] !== 255 || img.data[i * 4 + 2] !== 255) inked++;
      expect(inked, scene.id).toBeGreaterThan(200);
    }
    expect(SCENES.length).toBe(19);
  });
  it('image: the tiger, turned 45°, through a process the host supplies', () => {
    const img = render('image');
    expect(px(img, 2, 2)).toEqual(WHITE); // the corners are outside the turned image
    expect(px(img, 128, 128)).not.toEqual(WHITE);
    // clip image: the tiger at 1:1 inside the circle, nothing outside.
    const clipped = render('clip_image');
    expect(px(clipped, 5, 5)).toEqual(WHITE);
    expect(px(clipped, 128, 128)).toEqual(px(tiger, 128, 128));
    // imagepattern: five tigers across, so the page is well covered.
    let inked = 0;
    const pat = render('imagepattern');
    for (let i = 0; i < 256 * 256; i++) if (pat.data[i * 4] !== 255 || pat.data[i * 4 + 1] !== 255) inked++;
    expect(inked).toBeGreaterThan(256 * 256 * 0.5);
  });
  it('arc: a thick black arc from 45° to 180°, and nothing on the other side', () => {
    const img = render('arc');
    expect(px(img, 128 + Math.round(100 * Math.cos(2)), 128 + Math.round(100 * Math.sin(2)))).toEqual([0, 0, 0]); // on the arc
    expect(px(img, 128 + Math.round(100 * Math.cos(-1)), 128 + Math.round(100 * Math.sin(-1)))).toEqual(WHITE); // off it
  });
  it('clip: everything outside the circle stays white', () => {
    const img = render('clip');
    expect(px(img, 5, 5)).toEqual(WHITE);
    expect(px(img, 128, 128)).not.toEqual(WHITE);
    expect(px(img, 128, 60)).toEqual([0, 0, 0]); // inside the clip, filled black
  });
  it('fill style: even-odd leaves the circles empty, winding fills the one wound the same way', () => {
    const img = render('fill_style');
    expect(px(img, 64, 64)).toEqual(WHITE); // even-odd: inside the left circle
    expect(px(img, 192, 64)).toEqual(WHITE); // and the right
    expect(px(img, 64, 192)).not.toEqual(WHITE); // winding: the left circle winds with the rectangle
    expect(px(img, 192, 192)).toEqual(WHITE); // the right winds against it
    expect(px(img, 30, 60)[1]).toBeGreaterThan(150); // green, between
  });
  it('gradient: the sky runs white to black down the page', () => {
    const img = render('gradient');
    expect(px(img, 20, 3)[0]).toBeGreaterThan(240);
    expect(px(img, 20, 252)[0]).toBeLessThan(15);
    expect(px(img, 128, 110)[0]).toBeGreaterThan(200); // the sun's centre is white
  });
  it('dash: ink and gaps along the line', () => {
    const img = render('dash');
    // The line from (128, 25.6) towards (230.4, 230.4): the first 20 are ink, then a gap.
    const at = (d: number) => px(img, Math.round(128 + 102.4 * d / 229), Math.round(25.6 + 204.8 * d / 229));
    expect(at(8)).toEqual([0, 0, 0]);
    expect(at(25)).toEqual(WHITE);
    expect(at(70)).toEqual([0, 0, 0]);
  });
});
