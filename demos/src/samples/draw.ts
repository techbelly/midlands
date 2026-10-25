// A Cairo-like drawing context whose every operation is compiled Nile: fill
// (either rule), stroke (caps, joins, dashes), clip to a path, paint with a
// gradient. The host builds paths (path.ts) and writes the pixels Nile
// produces (spans.ts); nothing geometric happens here. DOM-free, so the
// samples render headless in tests as well as on the page.

import type { Api } from '../vector/draw.js';
import { writePixels, type ImgLike } from '../vector/spans.js';
import type { Path } from './path.js';

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

  constructor(private readonly nile: Api, private readonly img: ImgLike) {
    this.box = { min: [0, 0], max: [img.width, img.height] };
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
