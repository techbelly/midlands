// The paint page's host side, DOM-free (shared with the headless GPU check):
// the sample shapes and their geometry through compiled Nile (pixels are
// written by spans.ts writePixels). A paint program is gezira's library + nl/vector.nl +
// nl/rasterize2.nl + nl/spans.nl + the user's `Paint` + PAINT_GLUE.

import { strokeOutline, type Api } from './draw.js';

export const PAINT_GLUE = `
PaintBeziers (min, max : Point) : Bezier >> PaintedPixel
    ⇒ ClipBeziers (min, max) → Rasterize → ApplyTexture (Paint)
`;

const K = 0.5523; // circle-by-cubics constant
const disc = (cx: number, cy: number, r: number): number[][] => {
  const k = r * K;
  return [
    [cx + r, cy, cx + r, cy + k, cx + k, cy + r, cx, cy + r],
    [cx, cy + r, cx - k, cy + r, cx - r, cy + k, cx - r, cy],
    [cx - r, cy, cx - r, cy - k, cx - k, cy - r, cx, cy - r],
    [cx, cy - r, cx + k, cy - r, cx + r, cy - k, cx + r, cy],
  ];
};
const line = (p: number[], q: number[]): number[] => [
  p[0], p[1], p[0] + (q[0] - p[0]) / 3, p[1] + (q[1] - p[1]) / 3,
  p[0] + (2 * (q[0] - p[0])) / 3, p[1] + (2 * (q[1] - p[1])) / 3, q[0], q[1],
];
const star = (cx: number, cy: number, r0: number, r1: number): number[][] => {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? r1 : r0;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
  return pts.map((p, i) => line(p, pts[(i + 1) % 10]));
};
const wave = [[40, 255, 120, 175, 200, 335, 280, 255], [280, 255, 330, 205, 370, 220, 400, 250]];

// The shapes as clipped beziers (one batch per shape), all geometry in Nile:
// a disc and a star flattened from cubics, and a thick round-capped stroke.
export function paintShapes(nile: Api, W: number, H: number): number[][][] {
  const clip = (bs: number[][]) => nile.ClipBeziers({ min: [0, 0], max: [W, H] }).run(bs);
  const flat = (cubics: number[][]) => clip(nile.FlattenCubics().run(cubics));
  return [
    flat(disc(110, 115, 85)),
    flat(star(320, 120, 42, 100)),
    clip(strokeOutline(nile, [1, 0, 0, 1, 0, 0], 34, -1, -1, [wave])),
  ];
}
