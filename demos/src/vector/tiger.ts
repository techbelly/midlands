// The Ghostscript Tiger demo, host side — ported from chari/web, adapted to
// umgeni's flat tokens: a cubic is 8 numbers, a span is 4. All geometry
// (transform, cubic flattening, stroke expansion, clipping, rasterization)
// runs in compiled Nile — gezira's own stroke/bezier/rasterize source plus
// nl/vector.nl. The host parses the SVG (svg.ts) and composites spans
// (spans.ts). DOM-free: shared by the browser demo and tests.

import { collectSpans, get, strokeOutline, SVG_CAP, SVG_JOIN, type Registry } from './draw.js';
import { hexRGB, paintSpans, type ImgLike } from './spans.js';
import type { Svg } from './svg.js';

// Compose affine transforms: result applies `b` then `a`.
export function mul(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

// Fit the tiger's 900×900 viewBox into W×H.
export function fitView(W: number, H: number): number[] {
  const s = Math.min(W, H) / 900;
  return [s, 0, 0, s, (W - 900 * s) / 2, (H - 900 * s) / 2];
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
  const m = mul(view, tiger.matrix);
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const clip = [0, 0, clipW, clipH];
  const transform = get(registry, 'TransformCubics');
  const flatten = get(registry, 'FlattenCubics');
  const clipK = get(registry, 'ClipBeziers');
  const batches: PathBatch[] = [];
  const push = (beziers: number[][], hex: string) => {
    if (beziers.length === 0) return;
    const [r, g, b] = hexRGB(hex);
    batches.push({ beziers: new Float32Array(beziers.flat()), n: beziers.length, color: [r / 255, g / 255, b / 255] });
  };
  const clipped = (beziers: number[][]) => collectSpans(clipK(clip), beziers);

  for (const path of tiger.paths) {
    if (path.fill) {
      const flat = collectSpans(flatten(), collectSpans(transform(m), path.cubics));
      push(clipped(flat), path.fill);
    }
    if (path.stroke) {
      const w = Math.max(minStroke, path.strokeWidth * scale);
      push(clipped(strokeOutline(registry, m, w, SVG_JOIN, SVG_CAP, path.subpaths)), path.stroke);
    }
  }
  return batches;
}

// Returns the number of paths drawn. Everything geometric runs in compiled
// Nile — gezira's own kernels plus nl/vector.nl; clip bounds = the canvas.
export function drawTiger(
  img: ImgLike,
  tiger: Svg,
  view: number[],
  registry: Registry,
  minStroke = 0.75,
): number {
  const m = mul(view, tiger.matrix);
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const clip = [0, 0, img.width, img.height];
  const fill = get(registry, 'FillPath');
  const fillBeziers = get(registry, 'FillBeziers');
  for (const path of tiger.paths) {
    if (path.fill) {
      paintSpans(img, collectSpans(fill([...m, ...clip]), path.cubics), hexRGB(path.fill));
    }
    if (path.stroke) {
      const w = Math.max(minStroke, path.strokeWidth * scale);
      const outline = strokeOutline(registry, m, w, SVG_JOIN, SVG_CAP, path.subpaths);
      paintSpans(img, collectSpans(fillBeziers(clip), outline), hexRGB(path.stroke));
    }
  }
  return tiger.paths.length;
}
