// The Ghostscript Tiger demo, host side — ported from chari/web, adapted to
// umgeni's flat tokens: a cubic is 8 numbers, a span is 4. All geometry
// (transform, cubic flattening, stroke expansion, clipping, rasterization)
// runs in compiled Nile — gezira's own stroke/bezier/rasterize source plus
// nl/vector.nl and nl/svg.nl, which also compose the view with the SVG's
// transform and scale stroke widths. The host lexes the SVG (svg.ts),
// chooses the view, and composites spans (spans.ts). DOM-free: shared by the
// browser demo and tests.

import type { Api } from './draw.js';
import { hexRGB, paintSpans, type ImgLike } from './spans.js';
import type { Cubic, Svg } from './svg.js';

// Fit the tiger's 900×900 viewBox into W×H.
export function fitView(W: number, H: number): number[] {
  const s = Math.min(W, H) / 900;
  return [s, 0, 0, s, (W - 900 * s) / 2, (H - 900 * s) / 2];
}

// SVG's stroke defaults: miter joins with limit 4, butt caps. (gezira:
// join l < 0 is round, otherwise a miter with that limit; cap c < 0 is round,
// otherwise a square extension of c × half-width, so 0 is butt.)
const SVG_JOIN = 4;
const SVG_CAP = 0;

// A path's stroke outline under the view: SvgStroke (nl/svg.nl) once per
// subpath, the outlines filled together so overlaps aren't double-painted.
function stroke(nile: Api, tiger: Svg, view: number[], w: number, minStroke: number, subpaths: Cubic[][]) {
  return subpaths.flatMap((sub) => nile.SvgStroke({ V: view, R: tiger.matrix, w, minw: minStroke, l: SVG_JOIN, c: SVG_CAP }).run(sub));
}

// The GPU front half: run each path's geometry (transform → flatten →
// [stroke] → clip, compiled Nile on the CPU) and return flat bezier batches
// with normalized colors, ready for the GPU rasterizer+compositor.
export interface PathBatch {
  beziers: Float32Array<ArrayBuffer>;
  n: number;
  color: readonly [number, number, number];
}

export function tigerBatches(
  tiger: Svg,
  view: number[],
  nile: Api,
  clipW: number,
  clipH: number,
  minStroke = 0.75,
): PathBatch[] {
  const clip = { min: [0, 0], max: [clipW, clipH] };
  const batches: PathBatch[] = [];
  const push = (beziers: number[][], hex: string) => {
    if (beziers.length === 0) return;
    const [r, g, b] = hexRGB(hex);
    batches.push({ beziers: new Float32Array(beziers.flat()), n: beziers.length, color: [r / 255, g / 255, b / 255] });
  };
  for (const path of tiger.paths) {
    if (path.fill) push(nile.SvgFillBeziers({ V: view, R: tiger.matrix, ...clip }).run(path.cubics), path.fill);
    if (path.stroke) {
      const outline = stroke(nile, tiger, view, path.strokeWidth, minStroke, path.subpaths);
      push(nile.ClipBeziers(clip).run(outline), path.stroke);
    }
  }
  return batches;
}

// Returns the number of paths drawn. Everything geometric runs in compiled
// Nile — gezira's own kernels plus nl/vector.nl and nl/svg.nl; clip bounds =
// the canvas.
export function drawTiger(
  img: ImgLike,
  tiger: Svg,
  view: number[],
  nile: Api,
  minStroke = 0.75,
): number {
  const clip = { min: [0, 0], max: [img.width, img.height] };
  for (const path of tiger.paths) {
    if (path.fill) {
      paintSpans(img, nile, nile.SvgFill({ V: view, R: tiger.matrix, ...clip }).run(path.cubics), hexRGB(path.fill));
    }
    if (path.stroke) {
      const outline = stroke(nile, tiger, view, path.strokeWidth, minStroke, path.subpaths);
      paintSpans(img, nile, nile.FillBeziers(clip).run(outline), hexRGB(path.stroke));
    }
  }
  return tiger.paths.length;
}
