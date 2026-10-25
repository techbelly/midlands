// Text as a path: a glyph's TrueType outline (quadratics, from ttf.ts) placed
// at a size with its baseline at (x, y), each quadratic raised to a cubic
// (exactly: the controls at two thirds of the way), so text fills and
// strokes like any other path. Extents are those of the outline's points,
// close enough to Cairo's ink extents for the samples.

import type { Font } from '../text/ttf.js';
import type { Cubic, Path } from './path.js';

export interface Extents {
  xBearing: number;
  yBearing: number;
  width: number;
  height: number;
  xAdvance: number;
}

// The glyphs' cubics in em units from (0, baseline), each glyph a list of
// contours (consecutive beziers that connect).
function contours(font: Font, text: string): { cubics: Cubic[][]; advance: number } {
  const out: Cubic[][] = [];
  let pen = 0;
  for (const ch of text) {
    const g = font.glyphFor(ch);
    let contour: Cubic[] = [];
    for (const [ax, ay, bx, by, cx, cy] of g.beziers) {
      const A = [pen + ax, ay - font.ascent], B = [pen + bx, by - font.ascent], C = [pen + cx, cy - font.ascent];
      const last = contour[contour.length - 1];
      if (last && (last[6] !== A[0] || last[7] !== A[1])) {
        out.push(contour);
        contour = [];
      }
      contour.push([A[0], A[1], A[0] + (2 * (B[0] - A[0])) / 3, A[1] + (2 * (B[1] - A[1])) / 3, C[0] + (2 * (B[0] - C[0])) / 3, C[1] + (2 * (B[1] - C[1])) / 3, C[0], C[1]]);
    }
    if (contour.length > 0) out.push(contour);
    pen += g.advance;
  }
  return { cubics: out, advance: pen };
}

export function textPath(font: Font, text: string, size: number, x: number, y: number): Path {
  const subpaths = contours(font, text).cubics.map((c) => c.map((q) => q.map((v, i) => (i % 2 === 0 ? x + size * v : y + size * v))));
  return { cubics: subpaths.flat(), subpaths };
}

export function textExtents(font: Font, text: string, size: number): Extents {
  const { cubics, advance } = contours(font, text);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cubics.flat()) {
    for (let i = 0; i < 8; i += 2) {
      x0 = Math.min(x0, c[i]); x1 = Math.max(x1, c[i]);
      y0 = Math.min(y0, c[i + 1]); y1 = Math.max(y1, c[i + 1]);
    }
  }
  if (x0 === Infinity) return { xBearing: 0, yBearing: 0, width: 0, height: 0, xAdvance: size * advance };
  return { xBearing: size * x0, yBearing: size * y0, width: size * (x1 - x0), height: size * (y1 - y0), xAdvance: size * advance };
}
