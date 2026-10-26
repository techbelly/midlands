// The Ghostscript Tiger demo, host side:
// umgeni's flat tokens: a cubic is 8 numbers, a span is 4. All geometry
// (transform, cubic flattening, stroke expansion, clipping, rasterization)
// runs in compiled Nile — gezira's own stroke/bezier/rasterize source plus
// nl/vector.nl and nl/svg.nl, which also compose the view with the SVG's
// transform and scale stroke widths. The host lexes the SVG (svg.ts),
// chooses the view, and composites spans (spans.ts). DOM-free: shared by the
// browser demo and tests.

import type { PathBatch } from '../../../umgeni/src/gpu/present.js';
import type { Api } from './draw.js';
import { hexRGB, paintSpans, type ImgLike, type RGB } from './spans.js';
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

// One pipeline, two back ends. The front half is shared: each path's
// geometry (transform → flatten → [stroke] → clip, compiled Nile on the CPU)
// becomes a list of beziers and a colour, in drawing order. Then either
// back end rasterizes and composites them: paintPaths on the CPU, or
// toBatches → the GPU presenter (gpu/present.ts).
export interface TigerPath {
  beziers: number[][];
  color: RGB;
}

export function tigerPaths(
  tiger: Svg,
  view: number[],
  nile: Api,
  clipW: number,
  clipH: number,
  minStroke = 0.75,
): TigerPath[] {
  const clip = { min: [0, 0], max: [clipW, clipH] };
  const paths: TigerPath[] = [];
  const push = (beziers: number[][], hex: string) => {
    if (beziers.length > 0) paths.push({ beziers, color: hexRGB(hex) });
  };
  for (const path of tiger.paths) {
    if (path.fill) push(nile.SvgFillBeziers({ V: view, R: tiger.matrix, ...clip }).run(path.cubics), path.fill);
    if (path.stroke) {
      const outline = stroke(nile, tiger, view, path.strokeWidth, minStroke, path.subpaths);
      push(nile.ClipBeziers(clip).run(outline), path.stroke);
    }
  }
  return paths;
}

// The CPU back end: rasterize each path and composite its spans, in order.
// RasterizeParallel is the same Nile the GPU lowers, run on the CPU.
export function paintPaths(img: ImgLike, nile: Api, paths: TigerPath[]): void {
  for (const p of paths) paintSpans(img, nile, nile.RasterizeParallel().run(p.beziers), p.color);
}

// The GPU back end's input: the same paths as f32 batches.
export function toBatches(paths: TigerPath[]): PathBatch[] {
  return paths.map(({ beziers, color }) => ({ tokens: new Float32Array(beziers.flat()), n: beziers.length, color }));
}

// The whole tiger on the CPU, clipped to the canvas. Returns the number of
// paths drawn.
export function drawTiger(img: ImgLike, tiger: Svg, view: number[], nile: Api, minStroke = 0.75): number {
  paintPaths(img, nile, tigerPaths(tiger, view, nile, img.width, img.height, minStroke));
  return tiger.paths.length;
}
