// Coverage spans → pixels. Expanding each span to its pixels and colouring
// them is Nile (nl/spans.nl: gezira's ExpandSpans and UniformColor); the
// host only writes the resulting pixels, since Nile has no random-access
// memory. The paint page writes its textured pixels the same way.

import { collectSpans, get, type Registry } from './draw.js';

export type RGB = readonly [number, number, number]; // 0..255

export function hexRGB(hex: string): RGB {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as RGB;
}

export interface ImgLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | number[];
}

// Composite (Color, CoveragePoint) tokens — premultiplied (a, r, g, b) in
// 0..1, then the pixel (centre n + 0.5, so it floors to n) and its coverage —
// over the image.
export function writePixels(img: ImgLike, tokens: number[][]): void {
  const { width, height, data } = img;
  for (const [a, r, g, b, x, y, c] of tokens) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) continue;
    const i = (yi * width + xi) * 4;
    const keep = 1 - a * c;
    data[i] = 255 * r * c + (data[i] as number) * keep;
    data[i + 1] = 255 * g * c + (data[i + 1] as number) * keep;
    data[i + 2] = 255 * b * c + (data[i + 2] as number) * keep;
    data[i + 3] = 255;
  }
}

// Coverage spans (flat [x, y, c, l]) painted in an opaque colour: PaintSpans
// in Nile, then written.
export function paintSpans(img: ImgLike, registry: Registry, spans: number[][], color: RGB): void {
  const paint = get(registry, 'PaintSpans')([1, color[0] / 255, color[1] / 255, color[2] / 255]);
  writePixels(img, collectSpans(paint, spans));
}
