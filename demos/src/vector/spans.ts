// Coverage spans → pixels. Expanding each span to its pixels and colouring
// them is Nile (roda/spans.nl: gezira's ExpandSpans and UniformColor); the
// host only writes the resulting pixels, since Nile has no random-access
// memory. The paint page writes its textured pixels the same way.

import type { Api } from './draw.js';

export type RGB = readonly [number, number, number]; // 0..1

export function hexRGB(hex: string): RGB {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as unknown as RGB;
}

export interface ImgLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | number[];
}

// A white page to draw on, laid out as ImageData is.
export const blankImage = (width: number, height: number): { width: number; height: number; data: Uint8ClampedArray } =>
  ({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });

// How many pixels are not white: whether, and roughly how much, was drawn.
export function inkedPixels(img: ImgLike): number {
  let n = 0;
  for (let i = 0; i < img.width * img.height * 4; i += 4) {
    if (img.data[i] !== 255 || img.data[i + 1] !== 255 || img.data[i + 2] !== 255) n++;
  }
  return n;
}

// Composite PaintedPixel tokens (roda/spans.nl) over the image: a colour,
// premultiplied (a, r, g, b) in 0..1, and a pixel (its centre n + 0.5, so it
// floors to n) with its coverage c. Field offsets are looked up once.
export function writePixels(img: ImgLike, nile: Api, tokens: number[][]): void {
  const { width, height, data } = img;
  const T = nile.types.PaintedPixel;
  const [A, R, G, B, X, Y, C] = ['C.a', 'C.r', 'C.g', 'C.b', 'P.x', 'P.y', 'P.c'].map(T.at);
  for (const t of tokens) {
    const a = t[A], r = t[R], g = t[G], b = t[B], x = t[X], y = t[Y], c = t[C];
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
// `color`: r, g, b in 0..1; a fourth component is ignored (coverage is the alpha).
export function paintSpans(img: ImgLike, nile: Api, spans: number[][], color: readonly number[]): void {
  writePixels(img, nile, nile.PaintSpans({ C: [1, color[0], color[1], color[2]] }).run(spans));
}
