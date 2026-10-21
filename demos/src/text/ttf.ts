// A small TrueType reader: just what text rendering needs. TrueType glyph
// outlines are quadratic Bézier contours — exactly gezira's Bezier type — so
// a glyph converts to pipeline tokens with no curve approximation at all.
//
// Read: head, hhea, maxp, hmtx (advances), cmap (formats 4 and 12), loca and
// glyf (simple and composite glyphs), and COLR v0 + CPAL colour layers (an
// emoji is a stack of outline glyphs, each with a palette colour). Variable
// fonts render their default instance (variation tables are ignored). No
// kerning or shaping yet.
// DOM- and filesystem-free: give it the font's bytes.

import type { Bez, Glyph, Rgba } from './stubfont.js';

export interface Font {
  /** Line height (ascender − descender + line gap), in em. */
  lineHeight: number;
  /** Ascender, in em: glyph y coordinates are measured down from it, so the
   *  baseline sits at y = ascent. */
  ascent: number;
  glyphFor(ch: string): Glyph;
  /** Does the font map this character (to something other than .notdef)? */
  has(ch: string): boolean;
}

export function parseTrueType(bytes: ArrayBuffer | Uint8Array): Font {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o: number) => v.getUint16(o);
  const i16 = (o: number) => v.getInt16(o);
  const u32 = (o: number) => v.getUint32(o);

  const tables = new Map<string, number>();
  for (let i = 0, n = u16(4); i < n; i++) {
    const r = 12 + 16 * i;
    tables.set(String.fromCharCode(...u8.subarray(r, r + 4)), u32(r + 8));
  }
  const table = (tag: string) => {
    const t = tables.get(tag);
    if (t === undefined) throw new Error(`font has no '${tag}' table (CFF-outline fonts are not supported)`);
    return t;
  };

  const head = table('head');
  const upm = u16(head + 18);
  const longLoca = i16(head + 50) === 1;
  const numGlyphs = u16(table('maxp') + 4);
  const hhea = table('hhea');
  const ascender = i16(hhea + 4);
  const descender = i16(hhea + 6);
  const lineGap = i16(hhea + 8);
  const numHMetrics = u16(hhea + 34);
  const hmtx = table('hmtx');
  const loca = table('loca');
  const glyf = table('glyf');

  const advance = (g: number) => u16(hmtx + 4 * Math.min(g, numHMetrics - 1));
  const glyphOffset = (g: number) =>
    longLoca ? [u32(loca + 4 * g), u32(loca + 4 * g + 4)] : [2 * u16(loca + 2 * g), 2 * u16(loca + 2 * g + 2)];

  // cmap: prefer a full-Unicode format 12 subtable, else format 4 (BMP).
  const cmap = table('cmap');
  let sub4 = -1;
  let sub12 = -1;
  for (let i = 0, n = u16(cmap + 2); i < n; i++) {
    const r = cmap + 4 + 8 * i;
    const platform = u16(r);
    const at = cmap + u32(r + 4);
    if (platform !== 0 && !(platform === 3 && (u16(r + 2) === 1 || u16(r + 2) === 10))) continue;
    if (u16(at) === 12) sub12 = at;
    else if (u16(at) === 4) sub4 = at;
  }
  function glyphIndex(cp: number): number {
    if (sub12 >= 0) {
      for (let i = 0, n = u32(sub12 + 12); i < n; i++) {
        const g = sub12 + 16 + 12 * i;
        if (cp >= u32(g) && cp <= u32(g + 4)) return u32(g + 8) + cp - u32(g);
      }
      return 0;
    }
    if (sub4 < 0 || cp > 0xffff) return 0;
    const segs = u16(sub4 + 6) / 2;
    const ends = sub4 + 14;
    const starts = ends + 2 * segs + 2;
    const deltas = starts + 2 * segs;
    const ranges = deltas + 2 * segs;
    for (let s = 0; s < segs; s++) {
      if (cp > u16(ends + 2 * s)) continue;
      const start = u16(starts + 2 * s);
      if (cp < start) return 0;
      const ro = u16(ranges + 2 * s);
      if (ro === 0) return (cp + i16(deltas + 2 * s)) & 0xffff;
      const g = u16(ranges + 2 * s + ro + 2 * (cp - start));
      return g === 0 ? 0 : (g + i16(deltas + 2 * s)) & 0xffff;
    }
    return 0;
  }

  // A glyph's contours in font units: points with on-curve flags.
  type Pt = { x: number; y: number; on: boolean };
  function contours(g: number, depth = 0): Pt[][] {
    if (g >= numGlyphs || depth > 8) return [];
    const [start, end] = glyphOffset(g);
    if (end <= start) return []; // no outline (space)
    const at = glyf + start;
    const n = i16(at);
    if (n < 0) return composite(at + 10, depth);
    const endPts = Array.from({ length: n }, (_, i) => u16(at + 10 + 2 * i));
    const count = n === 0 ? 0 : endPts[n - 1] + 1;
    let p = at + 10 + 2 * n;
    p += 2 + u16(p); // skip instructions
    const flags: number[] = [];
    while (flags.length < count) {
      const f = u8[p++];
      flags.push(f);
      if (f & 8) for (let r = u8[p++]; r > 0; r--) flags.push(f);
    }
    const coords = (short: number, same: number): number[] => {
      let c = 0;
      return flags.map((f) => {
        if (f & short) c += f & same ? u8[p++] : -u8[p++];
        else if (!(f & same)) { c += i16(p); p += 2; }
        return c;
      });
    };
    const xs = coords(2, 16);
    const ys = coords(4, 32);
    const out: Pt[][] = [];
    let first = 0;
    for (const last of endPts) {
      out.push(xs.slice(first, last + 1).map((x, i) => ({ x, y: ys[first + i], on: (flags[first + i] & 1) === 1 })));
      first = last + 1;
    }
    return out;
  }

  function composite(p: number, depth: number): Pt[][] {
    const out: Pt[][] = [];
    for (let more = true; more;) {
      const flags = u16(p);
      const g = u16(p + 2);
      p += 4;
      let dx: number;
      let dy: number;
      if (flags & 1) { dx = i16(p); dy = i16(p + 2); p += 4; } else { dx = (u8[p] << 24) >> 24; dy = (u8[p + 1] << 24) >> 24; p += 2; }
      if (!(flags & 2)) { dx = 0; dy = 0; } // point-matching placement: rare; not supported
      let [a, b, c, d] = [1, 0, 0, 1];
      const f2 = (o: number) => i16(o) / 16384;
      if (flags & 8) { a = d = f2(p); p += 2; }
      else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; }
      else if (flags & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
      for (const contour of contours(g, depth + 1)) {
        out.push(contour.map((q) => ({ x: a * q.x + c * q.y + dx, y: b * q.x + d * q.y + dy, on: q.on })));
      }
      more = (flags & 0x20) !== 0;
    }
    return out;
  }

  // Contours → quadratic beziers in em units, y down from the ascender.
  // Consecutive off-curve points imply an on-curve midpoint; a straight
  // segment becomes a bezier with its control at the midpoint.
  const X = (x: number) => x / upm;
  const Y = (y: number) => (ascender - y) / upm;
  function beziers(cs: Pt[][]): Bez[] {
    const out: Bez[] = [];
    for (const c of cs) {
      if (c.length < 2) continue;
      // Start from an on-curve point (or the midpoint of two off-curve ones).
      const s = c.findIndex((q) => q.on);
      const pts = s >= 0
        ? [...c.slice(s), ...c.slice(0, s)]
        : [{ x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2, on: true }, ...c.slice(1), c[0]];
      let cur = pts[0];
      let ctrl: Pt | null = null;
      const emit = (q: Pt, end: Pt) => out.push([X(cur.x), Y(cur.y), X(q.x), Y(q.y), X(end.x), Y(end.y)]);
      for (const q of [...pts.slice(1), pts[0]]) {
        if (q.on) {
          emit(ctrl ?? { x: (cur.x + q.x) / 2, y: (cur.y + q.y) / 2, on: false }, q);
          cur = q;
          ctrl = null;
        } else if (ctrl) {
          const mid = { x: (ctrl.x + q.x) / 2, y: (ctrl.y + q.y) / 2, on: true };
          emit(ctrl, mid);
          cur = mid;
          ctrl = q;
        } else {
          ctrl = q;
        }
      }
    }
    return out;
  }

  // COLR v0: base glyph → its layers (glyph, palette index); CPAL palette 0.
  const colr = new Map<number, { glyph: number; palette: number }[]>();
  const palette: Rgba[] = [];
  if (tables.has('COLR') && tables.has('CPAL') && u16(table('COLR')) === 0) {
    const c = table('COLR');
    const bases = c + u32(c + 4);
    const layers = c + u32(c + 8);
    for (let i = 0, n = u16(c + 2); i < n; i++) {
      const r = bases + 6 * i;
      colr.set(u16(r), Array.from({ length: u16(r + 4) }, (_, k) => {
        const l = layers + 4 * (u16(r + 2) + k);
        return { glyph: u16(l), palette: u16(l + 2) };
      }));
    }
    const p = table('CPAL');
    const records = p + u32(p + 8);
    const first = u16(p + 12); // palette 0's first colour record
    for (let i = 0, n = u16(p + 2); i < n; i++) {
      const r = records + 4 * (first + i); // B, G, R, A
      palette.push([u8[r + 2] / 255, u8[r + 1] / 255, u8[r] / 255, u8[r + 3] / 255]);
    }
  }

  const cache = new Map<string, Glyph>();
  return {
    lineHeight: (ascender - descender + lineGap) / upm,
    ascent: ascender / upm,
    has: (ch) => glyphIndex(ch.codePointAt(0) ?? 0) !== 0,
    glyphFor(ch: string): Glyph {
      let glyph = cache.get(ch);
      if (!glyph) {
        const g = glyphIndex(ch.codePointAt(0) ?? 0);
        const layers = colr.get(g);
        if (layers) {
          const parts = layers.map((l) => ({ bs: beziers(contours(l.glyph)), color: palette[l.palette] ?? null }));
          glyph = {
            advance: advance(g) / upm,
            beziers: parts.flatMap((p) => p.bs),
            colors: parts.flatMap((p) => p.bs.map(() => p.color)),
          };
        } else {
          glyph = { advance: advance(g) / upm, beziers: beziers(contours(g)) };
        }
        cache.set(ch, glyph);
      }
      return glyph;
    },
  };
}
