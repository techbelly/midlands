// A stub vector font: hand-authored uppercase skeleton glyphs, deliberately
// simple so day one is not spent parsing TrueType. Each glyph is a set of
// filled contours built from thick line segments; O and Q are quadratic
// rounded-rect rings so the rasterizer's curve subdivision gets real work.
//
// Coordinates: a 4×6 design grid (y down, cap top at 0, baseline at 6, small
// descender room below), normalized to a 1.0 em by dividing by 8. Beziers are
// flat [ax, ay, bx, by, cx, cy], matching the compiler's token layout.

export type Bez = [number, number, number, number, number, number];

export type Rgba = readonly [number, number, number, number]; // 0..1

export interface Glyph {
  advance: number; // em units
  beziers: Bez[];  // em units, y down, origin at glyph left / cap top
  /** Colour glyphs (COLR): the colour of each bezier, layer by layer, in
   *  painting order; null = the text's own colour. Absent: one colour. */
  colors?: (Rgba | null)[];
}

const EM = 8; // grid units per em
const THICK = 0.9; // stroke thickness in grid units

type Pt = [number, number];

const line = (a: Pt, c: Pt): Bez => [a[0], a[1], (a[0] + c[0]) / 2, (a[1] + c[1]) / 2, c[0], c[1]];
const quad = (a: Pt, b: Pt, c: Pt): Bez => [a[0], a[1], b[0], b[1], c[0], c[1]];

// A thick line segment as a filled quadrilateral (square caps, slightly
// extended so joined segments meet without notches).
function seg(x0: number, y0: number, x1: number, y1: number, t = THICK): Bez[] {
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const dx = (x1 - x0) / len;
  const dy = (y1 - y0) / len;
  const ex = (dx * t) / 2;
  const ey = (dy * t) / 2;
  const nx = (-dy * t) / 2;
  const ny = (dx * t) / 2;
  const a: Pt = [x0 - ex + nx, y0 - ey + ny];
  const b: Pt = [x1 + ex + nx, y1 + ey + ny];
  const c: Pt = [x1 + ex - nx, y1 + ey - ny];
  const d: Pt = [x0 - ex - nx, y0 - ey - ny];
  return [line(a, b), line(b, c), line(c, d), line(d, a)];
}

// A rounded rectangle contour (clockwise in y-down coordinates).
function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number): Bez[] {
  return [
    line([x0 + r, y0], [x1 - r, y0]),
    quad([x1 - r, y0], [x1, y0], [x1, y0 + r]),
    line([x1, y0 + r], [x1, y1 - r]),
    quad([x1, y1 - r], [x1, y1], [x1 - r, y1]),
    line([x1 - r, y1], [x0 + r, y1]),
    quad([x0 + r, y1], [x0, y1], [x0, y1 - r]),
    line([x0, y1 - r], [x0, y0 + r]),
    quad([x0, y0 + r], [x0, y0], [x0 + r, y0]),
  ];
}

// Reverse a contour so it winds the other way (a counter: the hole in O).
function reversed(bezs: Bez[]): Bez[] {
  return bezs.map(([ax, ay, bx, by, cx, cy]): Bez => [cx, cy, bx, by, ax, ay]).reverse();
}

// A ring: outer contour minus an inner counter.
function ring(x0: number, y0: number, x1: number, y1: number, r: number, t = THICK): Bez[] {
  return [
    ...roundedRect(x0, y0, x1, y1, r),
    ...reversed(roundedRect(x0 + t, y0 + t, x1 - t, y1 - t, Math.max(0.2, r - t / 2))),
  ];
}

// Skeleton strokes per letter, as segment endpoints on the design grid.
type Stroke = [number, number, number, number];
const STROKES: Record<string, Stroke[]> = {
  A: [[0, 6, 2, 0], [2, 0, 4, 6], [0.9, 4, 3.1, 4]],
  B: [[0, 0, 0, 6], [0, 0, 3.2, 0], [0, 3, 3.2, 3], [0, 6, 3.2, 6], [3.2, 0, 3.2, 3], [3.2, 3, 3.2, 6]],
  C: [[0, 0, 0, 6], [0, 0, 4, 0], [0, 6, 4, 6]],
  D: [[0, 0, 0, 6], [0, 0, 2.8, 0], [0, 6, 2.8, 6], [2.8, 0, 4, 1.4], [4, 1.4, 4, 4.6], [4, 4.6, 2.8, 6]],
  E: [[0, 0, 0, 6], [0, 0, 4, 0], [0, 3, 3, 3], [0, 6, 4, 6]],
  F: [[0, 0, 0, 6], [0, 0, 4, 0], [0, 3, 3, 3]],
  G: [[0, 0, 0, 6], [0, 0, 4, 0], [0, 6, 4, 6], [4, 6, 4, 3.2], [2.4, 3.2, 4, 3.2]],
  H: [[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]],
  I: [[2, 0, 2, 6], [0.8, 0, 3.2, 0], [0.8, 6, 3.2, 6]],
  J: [[3.2, 0, 3.2, 6], [0, 6, 3.2, 6], [0, 4.5, 0, 6]],
  K: [[0, 0, 0, 6], [0, 3, 4, 0], [0, 3, 4, 6]],
  L: [[0, 0, 0, 6], [0, 6, 4, 6]],
  M: [[0, 6, 0, 0], [0, 0, 2, 3], [2, 3, 4, 0], [4, 0, 4, 6]],
  N: [[0, 6, 0, 0], [0, 0, 4, 6], [4, 6, 4, 0]],
  P: [[0, 0, 0, 6], [0, 0, 3.2, 0], [3.2, 0, 3.2, 3], [0, 3, 3.2, 3]],
  R: [[0, 0, 0, 6], [0, 0, 3.2, 0], [3.2, 0, 3.2, 3], [0, 3, 3.2, 3], [1.5, 3, 4, 6]],
  S: [[0, 0, 4, 0], [0, 0, 0, 3], [0, 3, 4, 3], [4, 3, 4, 6], [0, 6, 4, 6]],
  T: [[0, 0, 4, 0], [2, 0, 2, 6]],
  U: [[0, 0, 0, 6], [0, 6, 4, 6], [4, 6, 4, 0]],
  V: [[0, 0, 2, 6], [2, 6, 4, 0]],
  W: [[0, 0, 1, 6], [1, 6, 2, 2], [2, 2, 3, 6], [3, 6, 4, 0]],
  X: [[0, 0, 4, 6], [4, 0, 0, 6]],
  Y: [[0, 0, 2, 2.6], [4, 0, 2, 2.6], [2, 2.6, 2, 6]],
  Z: [[0, 0, 4, 0], [4, 0, 0, 6], [0, 6, 4, 6]],
  '.': [[2, 5.4, 2, 6]],
  ',': [[2.1, 5.2, 1.7, 6.9]],
};

const CURVED: Record<string, Bez[]> = {
  O: ring(0, 0, 4, 6, 1.7),
  Q: [...ring(0, 0, 4, 6, 1.7), ...seg(2.6, 4.4, 4.4, 6.6)],
};

function scale(bezs: Bez[]): Bez[] {
  return bezs.map((b) => b.map((v) => v / EM) as Bez);
}

function buildGlyph(ch: string): Glyph | undefined {
  if (ch === ' ') return { advance: 3 / EM, beziers: [] };
  const curved = CURVED[ch];
  if (curved) return { advance: 5.6 / EM, beziers: scale(curved) };
  const strokes = STROKES[ch];
  if (!strokes) return undefined;
  const beziers = strokes.flatMap((s) => seg(...s));
  const maxX = Math.max(...strokes.flatMap((s) => [s[0], s[2]]));
  return { advance: (maxX + 1.6) / EM, beziers: scale(beziers) };
}

const GLYPHS = new Map<string, Glyph>();
for (const ch of [...Object.keys(STROKES), ...Object.keys(CURVED), ' ']) {
  GLYPHS.set(ch, buildGlyph(ch)!);
}

// Unknown characters render as a box (so nothing silently disappears).
const NOTDEF: Glyph = { advance: 5.6 / EM, beziers: scale(ring(0.4, 0, 3.6, 6, 0.2)) };

export function glyphFor(ch: string): Glyph {
  return GLYPHS.get(ch) ?? GLYPHS.get(ch.toUpperCase()) ?? NOTDEF;
}
