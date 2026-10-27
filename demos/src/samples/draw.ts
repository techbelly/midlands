// A Cairo-like drawing context whose every operation is compiled Nile: fill
// (either rule), stroke (caps, joins, dashes), clip to a path, paint with a
// gradient. The host builds paths (path.ts) and writes the pixels Nile
// produces (spans.ts); nothing geometric happens here. DOM-free, so the
// samples render headless in tests as well as on the page.
//
// A Sheet draws onto a Target. CpuTarget rasterizes and paints into an
// image, with clips, textures, images and meshes. GpuTarget collects each
// fill or stroke as its clipped beziers, a colour and the name of the
// pipeline that rasterizes them (RasterizePixels or its even-odd twin,
// lowered from their IR by the page), for gpu/present.ts to run; the
// geometry (flatten, stroke, dash, clip to the page) is the same Nile, on
// the CPU, as the tiger does it. What the presenter cannot draw — a clip, a
// texture, an image, a mesh — GpuTarget refuses with CpuOnly, naming why,
// and the page draws that scene on the CPU.

import { IDENTITY, type Api, type Matrix } from '../vector/draw.js';
import { writePixels, type ImgLike } from '../vector/spans.js';
import { path, type Path } from './path.js';
import type { Op } from '../../../umgeni/src/cpu/runtime.js';
import { pathBatch, type PathBatch } from '../../../umgeni/src/gpu/present.js';

export { IDENTITY, type Matrix } from '../vector/draw.js';
export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export const scale = (x: number, y: number): Matrix => [x, 0, 0, y, 0, 0];
export const rotate = (t: number): Matrix => [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0];
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

/** Why a scene is drawn on the CPU: the page says so beside it. */
export class CpuOnly extends Error {}

const CAP: Record<Cap, number> = { butt: 0, round: -1, square: 1 }; // gezira's c
const nileColor = (c: Rgba) => [c[3], c[0], c[1], c[2]]; // gezira's (a, r, g, b)

/** A Coons patch: four cubic sides (8 numbers each) and four corner colours. */
export interface Patch { T: number[]; B: number[]; L: number[]; R: number[]; colors: [Rgba, Rgba, Rgba, Rgba] }

/** Where a Sheet's shapes end up. The geometry is the Sheet's: a target is
 *  handed beziers already flattened (and, for a stroke, outlined). */
export interface Target {
  /** Paint beziers, in page space, in one colour under a fill rule. */
  shade(beziers: number[][], color: Rgba, rule: Rule): void;
  /** From now on, paint only inside these beziers (and any clip already set). */
  clip(beziers: number[][]): void;
  resetClip(): void;
  paintTexture(texture: 'PaintSky' | 'PaintSun', beziers: number[][]): void;
  paintImage(image: ImgLike, M: Matrix, extend: 'none' | 'repeat', pattern: Matrix): void;
  paintMesh(patches: Patch[]): void;
}

export class Sheet {
  /** `k` scales the page: Cairo's samples are drawn for 256 × 256, and a
   *  sheet with k = 2 draws the same picture on a 512 × 512 target. */
  constructor(private readonly nile: Api, private readonly target: Target, private readonly k = 1) {}

  fill(path: Path, color: Rgba, rule: Rule = 'winding'): void {
    this.target.shade(this.flatten(this.at(path.cubics)), color, rule);
  }

  stroke(path: Path, color: Rgba, s: Stroke): void {
    const l = s.join === 'round' ? -1 : s.join === 'bevel' ? 1 : (s.miterLimit ?? 10); // gezira's l
    const c = CAP[s.cap ?? 'butt'];
    const w = s.width * this.k;
    const outline = path.subpaths.flatMap((sub) => {
      if (!s.dash) return this.nile.StrokeOutline({ M: IDENTITY, w, l, c }).run(this.at(sub));
      const [on1, off1, on2, off2] = dashLengths(s.dash.pattern).map((d) => d * this.k);
      return this.nile.DashedStroke({ M: IDENTITY, w, l, c, on1, off1, on2, off2, phase: s.dash.offset * this.k }).run(this.at(sub));
    });
    this.target.shade(outline, color, 'winding');
  }

  /** From now on, paint only inside this path (and any clip already set). */
  clip(path: Path): void {
    this.target.clip(this.flatten(this.at(path.cubics)));
  }
  resetClip(): void {
    this.target.resetClip();
  }

  /** Fill a path with one of the samples' textures (nl/samples.nl). */
  paintTexture(texture: 'PaintSky' | 'PaintSun', path: Path): void {
    this.target.paintTexture(texture, this.flatten(this.at(path.cubics)));
  }

  /** Maps composed in order, the first applied last, as Cairo's translate,
   *  rotate and scale calls build the transform (roda/vector.nl's Compose). */
  matrix(...maps: Matrix[]): Matrix {
    return this.nile.Compose().run(maps.map((m) => [...m]))[0] as unknown as Matrix;
  }

  /** Cairo's paint with an image source: the whole page (within the clip)
   *  from the image placed by M (the transform in force), either once or
   *  repeated as a pattern, whose own matrix maps user space to the image. */
  paintImage(image: ImgLike, M: Matrix, extend: 'none' | 'repeat' = 'none', pattern: Matrix = IDENTITY): void {
    this.target.paintImage(image, this.k === 1 ? M : this.matrix(scale(this.k, this.k), M), extend, pattern);
  }

  /** A mesh gradient: Coons patches (roda/patch.nl). */
  paintMesh(patches: Patch[]): void {
    const side = (s: number[]) => s.map((v) => v * this.k);
    this.target.paintMesh(this.k === 1 ? patches : patches.map((p) => ({ ...p, T: side(p.T), B: side(p.B), L: side(p.L), R: side(p.R) })));
  }

  private flatten(cubics: number[][]): number[][] {
    return this.nile.FlattenCubics().run(cubics);
  }

  // Cubics scaled to the page: the sheet's one piece of geometry.
  private at(cubics: readonly number[][]): number[][] {
    return this.k === 1 ? (cubics as number[][]) : cubics.map((c) => c.map((v) => v * this.k));
  }
}

/** Draws into an image on the CPU: every operation is compiled Nile, and
 *  the host writes the pixels Nile produces (spans.ts). */
export class CpuTarget implements Target {
  private clipSpans: number[][] | null = null;
  private pageSpans: number[][] | null = null; // the whole page's coverage, once asked for
  private readonly box: { min: number[]; max: number[] };
  private readonly images: ImgLike[] = [];

  constructor(private readonly nile: Api, private readonly img: ImgLike) {
    this.box = { min: [0, 0], max: [img.width, img.height] };
    nile.provide('ReadImage', readImage(this.images));
  }

  shade(beziers: number[][], color: Rgba, rule: Rule): void {
    const C = nileColor(color);
    const spans = this.coverage(beziers, rule);
    const pixels = this.clipSpans
      ? this.nile.ClipPaint({ C }).run([...spans, ...this.clipSpans])
      : this.nile.PaintSpans({ C }).run(spans);
    writePixels(this.img, this.nile, pixels);
  }

  clip(beziers: number[][]): void {
    this.clipSpans = this.withinClip(this.coverage(beziers, 'winding'));
  }
  resetClip(): void {
    this.clipSpans = null;
  }

  paintTexture(texture: 'PaintSky' | 'PaintSun', beziers: number[][]): void {
    writePixels(this.img, this.nile, this.nile[texture](this.box).run(beziers));
  }

  paintImage(image: ImgLike, M: Matrix, extend: 'none' | 'repeat', pattern: Matrix): void {
    const img = this.imageIndex(image);
    const spans = this.withinClip(this.page());
    const pixels = extend === 'repeat'
      ? this.nile.PaintImageRepeat({ M, Mp: pattern, D: [image.width, image.height], img }).run(spans)
      : this.nile.PaintImage({ M, img }).run(spans);
    writePixels(this.img, this.nile, pixels);
  }

  paintMesh(patches: Patch[]): void {
    const { Patch } = this.nile.types;
    const tokens = patches.map((p) => Patch.make({ T: p.T, B: p.B, L: p.L, R: p.R, C00: nileColor(p.colors[0]), C10: nileColor(p.colors[1]), C01: nileColor(p.colors[2]), C11: nileColor(p.colors[3]), d: 0 }));
    writePixels(this.img, this.nile, this.nile.MeshPixels().run(tokens));
  }

  private coverage(beziers: number[][], rule: Rule): number[][] {
    return (rule === 'evenodd' ? this.nile.FillEvenOdd(this.box) : this.nile.FillWinding(this.box)).run(beziers);
  }

  // Spans inside the clip: Intersect joins two coverage streams pixel by
  // pixel, so its points come back as one-pixel spans. No clip: the spans.
  private withinClip(spans: number[][]): number[][] {
    if (!this.clipSpans) return spans;
    return this.nile.Intersect().run([...spans, ...this.clipSpans]).map((p) => [p[0], p[1], p[2], 1]);
  }

  // The whole page as coverage spans, for painting an image over it.
  private page(): number[][] {
    return this.pageSpans ??= this.coverage(this.nile.FlattenCubics().run(path().rectangle(0, 0, this.img.width, this.img.height).build().cubics), 'winding');
  }

  // An image's slot in the host's ReadImage table, adding it on first use.
  private imageIndex(image: ImgLike): number {
    const i = this.images.indexOf(image);
    return i >= 0 ? i : this.images.push(image) - 1;
  }
}

/** Collects batches for the GPU presenter: the beziers clipped to the page,
 *  the colour, and the rasterizer. Refuses what the presenter cannot draw. */
export class GpuTarget implements Target {
  private readonly box: { min: number[]; max: number[] };

  constructor(private readonly nile: Api, width: number, height: number, private readonly batches: PathBatch[]) {
    this.box = { min: [0, 0], max: [width, height] };
  }

  shade(beziers: number[][], color: Rgba, rule: Rule): void {
    const clipped = this.nile.ClipBeziers(this.box).run(beziers);
    this.batches.push(pathBatch(clipped, color, rule === 'evenodd' ? 'RasterizePixelsEvenOdd' : 'RasterizePixels'));
  }

  clip(): void {
    throw new CpuOnly('Intersect lowers to the GPU, but this page composites a clip on the CPU');
  }
  resetClip(): void {}

  paintTexture(): void {
    throw new CpuOnly('ApplyTexture pairs each pixel with its paint by DupZip, which has no parallel lowering (the paint page lowers a texture to a shader function instead)');
  }
  paintImage(): void {
    throw new CpuOnly('ReadImage is a process the host supplies; it has no GPU form yet');
  }
  paintMesh(): void {
    throw new CpuOnly('MeshPixels lowers to the GPU, but its pixels carry colours, and the presenter paints coverage in one colour per path');
  }
}

// Cairo repeats an odd-length pattern to make its on and off lengths alternate.
function dashLengths(p: number[]): [number, number, number, number] {
  if (p.length === 1) return [p[0], p[0], p[0], p[0]];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  if (p.length === 4) return [p[0], p[1], p[2], p[3]];
  throw new Error('a dash pattern here has 1, 2 or 4 lengths');
}
