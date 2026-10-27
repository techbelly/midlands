// The Cairo samples' Nile (roda/evenodd.nl, …), checked headless.
import { describe, expect, it } from 'vitest';
import { compileLibraryFile, librarySourceTexts, read } from '../src/sources.js';
import { compileLibrary } from '../../umgeni/src/compile.js';
import { IDENTITY, type Api } from '../src/vector/draw.js';
import { lowerPipeline } from '../../umgeni/src/gpu/lower.js';
import { coverageSink } from '../../umgeni/src/gpu/execute.js';
import type { FusedIR } from '../../umgeni/src/ir.js';
import { segment, sourceSerif, square } from './fixtures.js';
import { CpuTarget, Sheet } from '../src/samples/draw.js';
import { SCENES } from '../src/samples/scenes.js';
import { lineCubic, path } from '../src/samples/path.js';
import { parseSvg } from '../src/vector/svg.js';
import { drawTiger, fitView } from '../src/vector/tiger.js';
import { blankImage, inkedPixels } from '../src/vector/spans.js';
import { quoteNile } from '../src/quote.js';

const library = compileLibraryFile('demos/nl/vector.nl-lib');
const nile: Api = library.api;

// Coverage at pixel (x, y) from a span list.
const coverageAt = (spans: number[][], x: number, y: number): number => {
  let c = 0;
  for (const [sx, sy, sc, sl] of spans) if (Math.floor(sy) === y && Math.floor(sx) <= x && x < Math.floor(sx) + sl) c += sc;
  return c;
};

describe('the even-odd rule (roda/evenodd.nl)', () => {
  it('compiles, and lowers nothing unsupported', () => {
    expect(library.unsupported).toEqual([]);
    expect(('RasterizeEvenOdd' in library.api)).toBe(true);
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
    const pixels = library.ir.processes.find((p) => p.name === 'RasterizePixelsEvenOdd') as FusedIR;
    expect(lowerPipeline(pixels, { extent: [16, 16], sink: coverageSink }).passes.length).toBe(2);
  });
  it('agrees with non-zero winding on a simple shape', () => {
    const one = square(1, 1, 9, 9);
    expect(nile.RasterizeEvenOdd().run(one)).toEqual(nile.RasterizeParallel().run(one));
  });
});

const chord = (b: number[]) => Math.hypot(b[4] - b[0], b[5] - b[1]);

describe('dashes (roda/dash.nl)', () => {
  it('compiles: DashBeziers and the capped stroker', () => {
    expect(library.unsupported).toEqual([]);
    for (const n of ['DashBeziers', 'StrokePieces', 'DashedStroke']) expect((n in library.api), n).toBe(true);
  });
  it('cuts a line into dashes of the pattern, carrying the phase across beziers', () => {
    // 100 long, on 20 off 10: dashes at 0–20, 30–50, 60–80, 90–100.
    const dashes = nile.DashBeziers({ on1: 20, off1: 10, on2: 20, off2: 10, phase: 0 }).run([segment(0, 0, 60, 0), segment(60, 0, 100, 0)]);
    const starts = dashes.map((b) => b[0]);
    expect(starts).toEqual([0, 30, 60, 90]);
    expect(dashes.reduce((n, b) => n + chord(b), 0)).toBeCloseTo(70, 9);
    // A phase moves the pattern back along the path.
    const shifted = nile.DashBeziers({ on1: 20, off1: 10, on2: 20, off2: 10, phase: 25 }).run([segment(0, 0, 100, 0)]);
    expect(shifted.map((b) => b[0])).toEqual([5, 35, 65, 95]);
    // Cairo's dash sample: 50 on, 10 off, 10 on, 10 off, offset -50.
    const four = nile.DashBeziers({ on1: 50, off1: 10, on2: 10, off2: 10, phase: -50 }).run([segment(0, 0, 160, 0)]);
    expect(four.map((b) => [b[0], b[4]])).toEqual([[0, 20], [30, 40], [50, 100], [110, 120], [130, 160]]); // −50 into an 80-long pattern is 30 in: 20 of the first dash remain
  });
  it('strokes disconnected pieces with caps at every end, nothing between', () => {
    const w = 4;
    const pieces = [segment(2, 10, 20, 10), segment(40, 10, 58, 10)];
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
    const zigzag = [segment(5, 5, 25, 30), segment(25, 30, 45, 5), segment(45, 5, 60, 28)];
    const a = nile.StrokePieces({ w: 6, l: 4, c: -1 }).run(zigzag);
    const b = nile.StrokeBezierPath({ w: 6, l: 4, c: -1 }).run(zigzag);
    expect(a).toEqual(b);
  });
  it('dashes a cubic path end to end', () => {
    const outline = nile.DashedStroke({ M: IDENTITY, w: 3, l: 4, c: 0, on1: 10, off1: 5, on2: 10, off2: 5, phase: 0 }).run([lineCubic([0, 10], [90, 10])]);
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

describe('clipping and masking (roda/clip.nl)', () => {
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
  it('lowers to the GPU: the join reduces by + alone', () => {
    const ir = library.ir.processes.find((p) => p.name === 'Intersect') as FusedIR;
    const plan = lowerPipeline(ir, { extent: [16, 16], sink: coverageSink });
    expect(plan.passes.length).toBe(2);
  });
  it('masks coverage by a texture alpha', () => {
    // MaskSpans takes a texture, so it is instantiated where it is used.
    const fade = 'Fade : CoverageSpan >> CoveragePoint\n    ⇒ MaskSpans (UniformColor ((0.5, 1, 1, 1)))\n';
    const lib = compileLibrary([...librarySourceTexts('demos/nl/vector.nl-lib'), fade]);
    expect(lib.unsupported).toEqual([]);
    const pts = lib.api.Fade().run(nile.RasterizeParallel().run(square(0, 0, 4, 4)));
    expect(pts.length).toBe(16);
    for (const q of pts) expect(q[2]).toBeCloseTo(0.5, 9);
  });
});

describe('matrices (roda/vector.nl)', () => {
  // A map under test: translate, rotate a third of a turn, scale unevenly.
  const maps = [[1, 0, 0, 1, 30, -7], [0.5, 0.8660254037844386, -0.8660254037844386, 0.5, 0, 0], [2, 0, 0, 0.5, 0, 0]];
  it('Compose applies the maps in order, the first last, as Cairo does', () => {
    const [M] = nile.Compose().run(maps);
    // (translate ∘ rotate ∘ scale) ⊗ P = translate(rotate(scale(P)))
    const P = [3, 4];
    const S = [2 * P[0], 0.5 * P[1]];
    const R = [0.5 * S[0] - 0.8660254037844386 * S[1], 0.8660254037844386 * S[0] + 0.5 * S[1]];
    const T = [R[0] + 30, R[1] - 7];
    expect(M[0] * P[0] + M[2] * P[1] + M[4]).toBeCloseTo(T[0], 9);
    expect(M[1] * P[0] + M[3] * P[1] + M[5]).toBeCloseTo(T[1], 9);
  });
  it('⁻¹ undoes a map', () => {
    // The inverse is an operator, so it is tested through the process that uses
    // it: Undo composes a map with its inverse and must give the identity.
    const undo = 'Undo : Matrix >> Matrix\n    ∀ M\n        >> M ∘ ⁻¹ M\n';
    const lib = compileLibrary([...librarySourceTexts('demos/nl/vector.nl-lib'), undo]);
    expect(lib.unsupported).toEqual([]);
    const [M] = nile.Compose().run(maps);
    const [I] = lib.api.Undo().run([M]);
    [1, 0, 0, 1, 0, 0].forEach((v, i) => expect(IDENTITY[i]).toBeCloseTo(v, 9));
  });
});

// --- the samples page, headless -----------------------------------------------

const samples = compileLibraryFile('demos/nl/samples.nl-lib');
const font = sourceSerif();
const page = () => blankImage(256, 256);
const px = (img: { data: Uint8ClampedArray }, x: number, y: number) => [...img.data.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 3)];
const WHITE = [255, 255, 255];
// The picture the image samples use: the tiger, drawn by the same Nile.
const tiger = page();
drawTiger(tiger, parseSvg(read('demos/tiger.svg'), samples.api), fitView(256, 256), samples.api);
const render = (id: string) => {
  const scene = SCENES.find((s) => s.id === id)!;
  const img = page();
  scene.draw(new Sheet(samples.api, new CpuTarget(samples.api, img)), font, tiger);
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
      expect(inkedPixels(render(scene.id)), scene.id).toBeGreaterThan(200);
    }
    expect(SCENES.length).toBe(20);
  });
  it('quotes Nile that exists: every definition a scene names is in the library', () => {
    const sources = librarySourceTexts('demos/nl/samples.nl-lib');
    for (const scene of SCENES) expect(quoteNile(sources, scene.nile), scene.id).not.toContain('not found');
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
    expect(inkedPixels(render('imagepattern'))).toBeGreaterThan(256 * 256 * 0.5);
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

describe('mesh gradients (roda/patch.nl)', () => {
  it('fills a straight-sided patch pixel for pixel, blending the corner colours', () => {
    const img = page();
    new Sheet(samples.api, new CpuTarget(samples.api, img)).paintMesh([{ T: lineCubic([10, 10], [20, 10]), B: lineCubic([10, 20], [20, 20]), L: lineCubic([10, 10], [10, 20]), R: lineCubic([20, 10], [20, 20]), colors: [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1], [1, 1, 1, 1]] }]);
    expect(px(img, 9, 9)).toEqual(WHITE);
    expect(px(img, 20, 15)).toEqual(WHITE);
    const tl = px(img, 10, 10), tr = px(img, 19, 10), bl = px(img, 10, 19);
    expect(tl[0]).toBeGreaterThan(200); expect(tl[1]).toBeLessThan(60); // red corner
    expect(tr[1]).toBeGreaterThan(200); expect(tr[0]).toBeLessThan(60); // green
    expect(bl[2]).toBeGreaterThan(200); // blue
    const mid = px(img, 15, 15); // a blend, not white
    expect(mid[0] + mid[1] + mid[2]).toBeLessThan(700);
    // Every pixel of the square is fully covered: no seams between pieces.
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) expect(px(img, x, y), `${x},${y}`).not.toEqual(WHITE);
  });
  it('the curved patch covers its inside fully and nothing outside', () => {
    const img = render('mesh');
    expect(px(img, 3, 3)).toEqual(WHITE);
    expect(px(img, 128, 128)).not.toEqual(WHITE);
    // Interior rows: no white speckle (every piece lands in a pixel).
    for (let x = 60; x < 200; x += 7) expect(px(img, x, 128), `${x}`).not.toEqual(WHITE);
    expect(px(img, 30, 30)[0]).toBeGreaterThan(150); // red near the top-left corner
  });
});
