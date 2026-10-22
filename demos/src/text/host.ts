// The pure host side of the text pipeline (no filesystem, no DOM — shared by
// tests, node rendering, and the web demo): string -> GlyphBezier tokens in,
// CoverageSpans -> coverage buffer out. Everything geometric in between (pen
// advance, line wrapping, transform, clip, rasterization) is compiled Nile —
// see nl/text.nl.

import { run, type Api, type Op, type Token } from '../../../umgeni/src/cpu/runtime.js';
import { glyphFor as stubGlyph, type Glyph, type Rgba } from './stubfont.js';

/** Where glyph outlines come from: the stub font, or a TrueType font (ttf.ts). */
export type GlyphSource = (ch: string) => Glyph;

// Font fallback, as a browser does: each character from the first font that
// has it (else the first font's .notdef), moved onto the first font's
// baseline (each font measures y down from its own ascender).
interface FallbackFont {
  glyphFor: GlyphSource;
  has(ch: string): boolean;
  ascent: number;
}
export function fallback(...fonts: FallbackFont[]): GlyphSource {
  const base = fonts[0].ascent;
  return (ch) => {
    const font = fonts.find((f) => f.has(ch)) ?? fonts[0];
    const g = font.glyphFor(ch);
    const dy = base - font.ascent;
    if (dy === 0) return g;
    return { ...g, beziers: g.beziers.map(([ax, ay, bx, by, cx, cy]) => [ax, ay + dy, bx, by + dy, cx, cy + dy]) };
  };
}

// A GlyphBezier token (nl/text.nl): (Z : Bezier, adv, first, kind, rest). Every outline bezier of a glyph carries the glyph's advance; `first`
// marks the token on which LayoutGlyphs advances the pen (and maybe wraps);
// `kind` is 0 glyph / 1 space / 2 line break; `rest` is computed in Nile
// (WordWidths). A space or break has no outline, so it travels as one
// degenerate zero-area bezier — the rasterizer emits nothing for it, but the
// layout kernel sees it.
export const textTokens = (nile: Api, text: string, glyphFor: GlyphSource = stubGlyph): Token[] =>
  glyphTokens(nile, text, glyphFor).tokens;

// Invisible in emoji text without shaping: zero-width joiner, variation
// selectors (they select emoji presentation, which a colour font already has).
const IGNORABLE = /[\u200D\uFE0E\uFE0F]/u;

// The tokens, plus each token's colour (colour glyphs: COLR layers; null =
// the text's own colour).
export function glyphTokens(nile: Api, text: string, glyphFor: GlyphSource = stubGlyph): { tokens: Token[]; colors: (Rgba | null)[] } {
  // A token per outline bezier, many per render: field offsets looked up once.
  const { GlyphBezier } = nile.types;
  const [Z, ADV, FIRST, KIND, REST] = ['Z', 'adv', 'first', 'kind', 'rest'].map(GlyphBezier.at);
  const token = (z: readonly number[], adv: number, first: number, kind: number): Token => {
    const t: Token = new Array(GlyphBezier.width);
    for (let i = 0; i < 6; i++) t[Z + i] = z[i];
    t[ADV] = adv;
    t[FIRST] = first;
    t[KIND] = kind;
    t[REST] = 0; // filled in by WordWidths
    return t;
  };
  const tokens: Token[] = [];
  const colors: (Rgba | null)[] = [];
  for (const ch of text) {
    if (IGNORABLE.test(ch)) continue;
    const kind = ch === '\n' ? 2 : /\s/.test(ch) ? 1 : 0;
    const glyph = kind === 2 ? { advance: 0, beziers: [] } : glyphFor(ch);
    if (glyph.beziers.length === 0) {
      tokens.push(token([0, 0, 0, 0, 0, 0], glyph.advance, 1, kind));
      colors.push(null);
      continue;
    }
    glyph.beziers.forEach((b, i) => {
      tokens.push(token(b, glyph.advance, i === 0 ? 1 : 0, kind));
      colors.push(glyph.colors?.[i] ?? null);
    });
  }
  return { tokens, colors };
}

// Colour text. Layout (TextLayout, in Nile) places tokens one-to-one and in
// order, so each token's colour rides alongside by position; consecutive
// beziers of one colour form a run. Runs are then rasterized and composited
// in order — painter's algorithm, like the tiger's paths. Plain text is one
// run in the text colour.
export interface ColorRun {
  color: Rgba | null; // null: the text colour
  beziers: Token[]; // laid out (em units), not yet transformed
}

export function colorRuns(nile: Api, layout: Op, text: string, glyphFor?: GlyphSource): ColorRun[] {
  const { tokens, colors } = glyphTokens(nile, text, glyphFor);
  const placed = run(layout, tokens);
  if (placed.length !== tokens.length) throw new Error('layout must place each token exactly once');
  const runs: ColorRun[] = [];
  const same = (a: Rgba | null, b: Rgba | null) => a === b || (a !== null && b !== null && a.every((x, i) => x === b[i]));
  placed.forEach((b, i) => {
    const last = runs[runs.length - 1];
    if (last && same(last.color, colors[i])) last.beziers.push(b);
    else runs.push({ color: colors[i], beziers: [b] });
  });
  return runs;
}

export interface RenderOptions {
  /** Pixel size of one em. */
  size: number;
  /** Target width/height in pixels. */
  width: number;
  height: number;
  /** Left/top margin in pixels. */
  margin?: number;
  /** Line height in em (the font's; the stub font's default is 1.15). */
  lineHeight?: number;
  /** Glyph outlines (default: the stub font). */
  glyphs?: GlyphSource;
}

// TextSpans' parameters, by name (nl/text.nl): layout is in em units, the
// matrix maps em to pixels, min and max are the clip rectangle.
export type TextSpansParams = {
  w: number; // wrap width, em
  lh: number; // line height, em
  M: number[];
  min: number[];
  max: number[];
};

export function textSpansParams(opts: RenderOptions): TextSpansParams {
  const margin = opts.margin ?? 4;
  const { size, width, height } = opts;
  return {
    w: (width - 2 * margin) / size,
    lh: opts.lineHeight ?? 1.15,
    M: [size, 0, 0, size, margin, margin],
    min: [0, 0],
    max: [width, height],
  };
}

export interface Driven {
  spans: number[][];
  tokens: number;
  /** Milliseconds spent streaming tokens through the compiled pipeline. */
  rasterMs: number;
}

export function driveTextSpans(nile: Api, op: Op, text: string, glyphs?: GlyphSource): Driven {
  const spans: number[][] = [];
  op.setEmit((t) => spans.push(t));
  const tokens = textTokens(nile, text, glyphs);
  const t0 = performance.now();
  for (const t of tokens) op.push(t);
  op.end();
  return { spans, tokens: tokens.length, rasterMs: performance.now() - t0 };
}

// Accumulate spans into a scalar coverage buffer (row-major, 0..1).
export function paintCoverage(spans: number[][], width: number, height: number): Float64Array {
  const buf = new Float64Array(width * height);
  for (const [x, y, c, l] of spans) {
    const cov = Math.min(1, Math.abs(c));
    if (cov === 0) continue;
    const yi = Math.floor(y);
    if (yi < 0 || yi >= height) continue;
    const x0 = Math.floor(x);
    const len = Math.round(l);
    for (let i = 0; i < len; i++) {
      const xi = x0 + i;
      if (xi < 0 || xi >= width) continue;
      buf[yi * width + xi] = Math.min(1, buf[yi * width + xi] + cov);
    }
  }
  return buf;
}

// Threshold a coverage buffer to ASCII art (tests, and honest eyeballing).
export function asciiArt(buf: Float64Array, width: number, height: number): string {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      const c = buf[y * width + x];
      row += c > 0.6 ? '#' : c > 0.15 ? '+' : '.';
    }
    rows.push(row);
  }
  return rows.join('\n');
}
