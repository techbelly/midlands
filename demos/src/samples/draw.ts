// A Cairo-like drawing context whose every operation is compiled Nile: fill
// (either rule), stroke (caps, joins, dashes), clip to a path, paint with a
// gradient. The host builds paths (path.ts) and writes the pixels Nile
// produces (spans.ts); nothing geometric happens here. DOM-free, so the
// samples render headless in tests as well as on the page.

import type { Api } from '../vector/draw.js';
import { writePixels, type ImgLike } from '../vector/spans.js';
import { path, type Path } from './path.js';
import type { Op } from '../../../umgeni/src/cpu/runtime.js';

/** An affine matrix as Cairo and gezira write it: (a, b, c, d, e, f). */
export type Matrix = readonly [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export const scale = (x: number, y: number): Matrix => [x, 0, 0, y, 0, 0];
export const rotate = (t: number): Matrix => [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0];
/** M then N, as Cairo composes: (M ∘ N) applies N first. multiply(M, N) = M ∘ N. */
export const multiply = (M: Matrix, N: Matrix): Matrix =>
  [M[0] * N[0] + M[2] * N[1], M[1] * N[0] + M[3] * N[1], M[0] * N[2] + M[2] * N[3], M[1] * N[2] + M[3] * N[3], M[0] * N[4] + M[2] * N[5] + M[4], M[1] * N[4] + M[3] * N[5] + M[5]];
export const invert = (M: Matrix): Matrix => {
  const det = M[0] * M[3] - M[1] * M[2];
  const [a, b, c, d] = [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det];
  return [a, b, c, d, -(a * M[4] + c * M[5]), -(b * M[4] + d * M[5])];
};

// ReadImage, the process the host supplies (nl/samples.nl): the pixel
// under a point, premultiplied, transparent outside the image. The images
// are kept in a table; a process parameter is a number, so an image is
// known to Nile by its index.
export function readImage(images: ImgLike[]): (P: number[]) => Op {
  return (P) => {
    const img = images[P[0]];
    let emit: (t: number[]) => void = () => {};
    return {
      push(t) {
        const x = Math.floor(t[0]), y = Math.floor(t[1]);
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) return emit([0, 0, 0, 0]);
        const i = (y * img.width + x) * 4;
        const a = (img.data[i + 3] as number) / 255;
        emit([a, (a * (img.data[i] as number)) / 255, (a * (img.data[i + 1] as number)) / 255, (a * (img.data[i + 2] as number)) / 255]);
      },
      end() {},
      setEmit(e) { emit = e; },
    };
  };
}

/** Cairo's order and range: red, green, blue, alpha in 0..1. */
export type Rgba = readonly [number, number, number, number];
export type Rule = 'winding' | 'evenodd';
export type Cap = 'butt' | 'round' | 'square';
export type Join = 'miter' | 'round' | 'bevel';
export interface Stroke {
  width: number;
  cap?: Cap;
  join?: Join;
  miterLimit?: number; // Cairo's default is 10
  dash?: { pattern: number[]; offset: number }; // 1, 2 or 4 lengths
}

const I = [1, 0, 0, 1, 0, 0];
const CAP: Record<Cap, number> = { butt: 0, round: -1, square: 1 }; // gezira's c
const nileColor = (c: Rgba) => [c[3], c[0], c[1], c[2]]; // gezira's (a, r, g, b)

export class Sheet {
  private clipSpans: number[][] | null = null;
  private readonly box: { min: number[]; max: number[] };
  private readonly images: ImgLike[] = [];

  constructor(private readonly nile: Api, private readonly img: ImgLike) {
    this.box = { min: [0, 0], max: [img.width, img.height] };
    nile.provide('ReadImage', readImage(this.images));
  }

  fill(path: Path, color: Rgba, rule: Rule = 'winding'): void {
    this.paint(this.coverage(this.flatten(path.cubics), rule), color);
  }

  stroke(path: Path, color: Rgba, s: Stroke): void {
    const l = s.join === 'round' ? -1 : s.join === 'bevel' ? 1 : (s.miterLimit ?? 10); // gezira's l
    const c = CAP[s.cap ?? 'butt'];
    const outline = path.subpaths.flatMap((sub) => {
      if (!s.dash) return this.nile.StrokeOutline({ M: I, w: s.width, l, c }).run(sub);
      const [on1, off1, on2, off2] = dashLengths(s.dash.pattern);
      return this.nile.DashedStroke({ M: I, w: s.width, l, c, on1, off1, on2, off2, phase: s.dash.offset }).run(sub);
    });
    this.paint(this.coverage(outline, 'winding'), color);
  }

  /** From now on, paint only inside this path (and any clip already set). */
  clip(path: Path): void {
    const spans = this.coverage(this.flatten(path.cubics), 'winding');
    this.clipSpans = this.clipSpans ? this.nile.Intersect().run([...spans, ...this.clipSpans]).map((p) => [p[0], p[1], p[2], 1]) : spans;
  }
  resetClip(): void {
    this.clipSpans = null;
  }

  /** Fill a path with one of the samples' textures (nl/samples.nl). */
  paintTexture(texture: 'PaintSky' | 'PaintSun', path: Path): void {
    writePixels(this.img, this.nile, this.nile[texture](this.box).run(this.flatten(path.cubics)));
  }

  /** Cairo's paint with an image source: the whole page (within the clip)
   *  from the image placed by M (image → page), repeated or not. */
  paintImage(image: ImgLike, M: Matrix, extend: 'none' | 'repeat' = 'none'): void {
    const img = this.images.indexOf(image) >= 0 ? this.images.indexOf(image) : this.images.push(image) - 1;
    const page = this.coverage(this.flatten(path().rectangle(0, 0, this.img.width, this.img.height).build().cubics), 'winding');
    const spans = this.clipSpans ? this.nile.Intersect().run([...page, ...this.clipSpans]).map((p) => [p[0], p[1], p[2], 1]) : page;
    const Mi = invert(M);
    const pixels = extend === 'repeat'
      ? this.nile.PaintImageRepeat({ Mi, D: [image.width, image.height], img }).run(spans)
      : this.nile.PaintImage({ Mi, img }).run(spans);
    writePixels(this.img, this.nile, pixels);
  }

  /** A mesh gradient: Coons patches (nl/patch.nl), each four cubic sides
   *  (top, bottom, left, right, as 8 numbers each) and four corner colours. */
  paintMesh(patches: { T: number[]; B: number[]; L: number[]; R: number[]; colors: [Rgba, Rgba, Rgba, Rgba] }[]): void {
    const { Patch } = this.nile.types;
    const tokens = patches.map((p) => Patch.make({ T: p.T, B: p.B, L: p.L, R: p.R, C00: nileColor(p.colors[0]), C10: nileColor(p.colors[1]), C01: nileColor(p.colors[2]), C11: nileColor(p.colors[3]), d: 0 }));
    writePixels(this.img, this.nile, this.nile.MeshPixels().run(tokens));
  }

  private flatten(cubics: number[][]): number[][] {
    return this.nile.FlattenCubics().run(cubics);
  }
  private coverage(beziers: number[][], rule: Rule): number[][] {
    return (rule === 'evenodd' ? this.nile.FillEvenOdd(this.box) : this.nile.FillWinding(this.box)).run(beziers);
  }
  private paint(spans: number[][], color: Rgba): void {
    const C = nileColor(color);
    const pixels = this.clipSpans
      ? this.nile.ClipPaint({ C }).run([...spans, ...this.clipSpans])
      : this.nile.PaintSpans({ C }).run(spans);
    writePixels(this.img, this.nile, pixels);
  }
}

// Cairo repeats an odd-length pattern to make its on and off lengths alternate.
function dashLengths(p: number[]): [number, number, number, number] {
  if (p.length === 1) return [p[0], p[0], p[0], p[0]];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  if (p.length === 4) return [p[0], p[1], p[2], p[3]];
  throw new Error('a dash pattern here has 1, 2 or 4 lengths');
}
