// The Ghostscript Tiger demo, host side — ported from chari/web, adapted to
// umgeni's flat tokens: a cubic is 8 numbers, a span is 4. All geometry
// (transform, cubic flattening, stroke expansion, clipping, rasterization)
// runs in compiled Nile — gezira's own stroke/bezier/rasterize source plus
// nl/vector.nl and nl/svg.nl, which also compose the view with the SVG's
// transform and scale stroke widths. The host lexes the SVG (svg.ts),
// chooses the view, and composites spans (spans.ts). DOM-free: shared by the
// browser demo and tests.

import { collectSpans, get, type Registry } from './draw.js';
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
function stroke(registry: Registry, tiger: Svg, view: number[], w: number, minStroke: number, subpaths: Cubic[][]) {
  const svgStroke = get(registry, 'SvgStroke');
  return subpaths.flatMap((sub) => collectSpans(svgStroke([...view, ...tiger.matrix, w, minStroke, SVG_JOIN, SVG_CAP]), sub));
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
  registry: Registry,
  clipW: number,
  clipH: number,
  minStroke = 0.75,
): PathBatch[] {
  const clip = [0, 0, clipW, clipH];
  const fill = get(registry, 'SvgFillBeziers');
  const clipK = get(registry, 'ClipBeziers');
  const batches: PathBatch[] = [];
  const push = (beziers: number[][], hex: string) => {
    if (beziers.length === 0) return;
    const [r, g, b] = hexRGB(hex);
    batches.push({ beziers: new Float32Array(beziers.flat()), n: beziers.length, color: [r / 255, g / 255, b / 255] });
  };
  for (const path of tiger.paths) {
    if (path.fill) push(collectSpans(fill([...view, ...tiger.matrix, ...clip]), path.cubics), path.fill);
    if (path.stroke) {
      const outline = stroke(registry, tiger, view, path.strokeWidth, minStroke, path.subpaths);
      push(collectSpans(clipK(clip), outline), path.stroke);
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
  registry: Registry,
  minStroke = 0.75,
): number {
  const clip = [0, 0, img.width, img.height];
  const fill = get(registry, 'SvgFill');
  const fillBeziers = get(registry, 'FillBeziers');
  for (const path of tiger.paths) {
    if (path.fill) {
      paintSpans(img, registry, collectSpans(fill([...view, ...tiger.matrix, ...clip]), path.cubics), hexRGB(path.fill));
    }
    if (path.stroke) {
      const outline = stroke(registry, tiger, view, path.strokeWidth, minStroke, path.subpaths);
      paintSpans(img, registry, collectSpans(fillBeziers(clip), outline), hexRGB(path.stroke));
    }
  }
  return tiger.paths.length;
}
