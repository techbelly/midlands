// Paths, built the way Cairo builds them (move_to, line_to, curve_to, arc,
// rectangle, close_path), as cubics. Building a path is the host's part, as
// lexing the SVG is for the tiger; everything from the cubics on is Nile.
// A subpath is closed if close_path closed it; filling closes every subpath,
// stroking only the closed ones (so the stroker caps or joins the ends).

import type { Cubic } from '../vector/svg.js';

export type { Cubic };
export type Pt = [number, number];

interface Subpath {
  start: Pt;
  cubics: Cubic[];
  closed: boolean;
}

export interface Path {
  /** Every subpath closed: the fill geometry. */
  cubics: Cubic[];
  /** As drawn, closed only by close_path: the stroke geometry, one list per subpath. */
  subpaths: Cubic[][];
}

// A straight segment as a cubic, its controls at a third and two thirds.
export const lineCubic = (p: readonly number[], q: readonly number[]): Cubic =>
  [p[0], p[1], p[0] + (q[0] - p[0]) / 3, p[1] + (q[1] - p[1]) / 3, p[0] + (2 * (q[0] - p[0])) / 3, p[1] + (2 * (q[1] - p[1])) / 3, q[0], q[1]];
const same = (p: Pt, q: Pt) => p[0] === q[0] && p[1] === q[1];

export class PathBuilder {
  private subpaths: Subpath[] = [];
  private current: Pt | null = null;
  private open: Subpath | null = null;

  moveTo(x: number, y: number): this {
    this.open = { start: [x, y], cubics: [], closed: false };
    this.subpaths.push(this.open);
    this.current = [x, y];
    return this;
  }
  /** Cairo's new_sub_path: the next segment starts a subpath of its own. */
  newSubPath(): this {
    this.open = null;
    this.current = null;
    return this;
  }
  lineTo(x: number, y: number): this {
    const p = this.pen(x, y);
    if (p) this.open!.cubics.push(lineCubic(p, [x, y]));
    this.current = [x, y];
    return this;
  }
  relLineTo(dx: number, dy: number): this {
    const [x, y] = this.current ?? [0, 0];
    return this.lineTo(x + dx, y + dy);
  }
  curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): this {
    const p = this.pen(x1, y1);
    if (p) this.open!.cubics.push([p[0], p[1], x1, y1, x2, y2, x3, y3]);
    this.current = [x3, y3];
    return this;
  }
  rectangle(x: number, y: number, w: number, h: number): this {
    return this.moveTo(x, y).relLineTo(w, 0).relLineTo(0, h).relLineTo(-w, 0).closePath();
  }
  /** An arc, angles increasing (clockwise on a y-down page), as Cairo's: a
   *  line from the current point to its start, if there is one. */
  arc(cx: number, cy: number, r: number, a1: number, a2: number): this {
    while (a2 < a1) a2 += 2 * Math.PI;
    return this.arcCubics(cx, cy, r, a1, a2);
  }
  arcNegative(cx: number, cy: number, r: number, a1: number, a2: number): this {
    while (a2 > a1) a2 -= 2 * Math.PI;
    return this.arcCubics(cx, cy, r, a1, a2);
  }
  closePath(): this {
    if (this.open && !this.open.closed) {
      if (this.current && !same(this.current, this.open.start)) this.open.cubics.push(lineCubic(this.current, this.open.start));
      this.open.closed = true;
      this.current = this.open.start;
      this.open = null; // Cairo: a move_to to the start follows, implicitly
    }
    return this;
  }
  build(): Path {
    const drawn = this.subpaths.filter((s) => s.cubics.length > 0);
    return {
      cubics: drawn.flatMap((s) => (s.closed ? s.cubics : [...s.cubics, lineCubic(end(s), s.start)]).filter((c) => !degenerate(c))),
      subpaths: drawn.map((s) => s.cubics),
    };
  }

  // The point the next segment starts from, opening a subpath if need be.
  private pen(x: number, y: number): Pt | null {
    if (!this.open) {
      if (!this.current) {
        this.moveTo(x, y);
        return null;
      }
      this.moveTo(this.current[0], this.current[1]);
    }
    return this.current!;
  }
  // At most a quarter turn per cubic (the usual 4/3 tan(θ/4) controls).
  private arcCubics(cx: number, cy: number, r: number, a1: number, a2: number): this {
    const at = (a: number): Pt => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const n = Math.max(1, Math.ceil(Math.abs(a2 - a1) / (Math.PI / 2) - 1e-9));
    const start = at(a1);
    if (this.current && !same(this.current, start)) this.lineTo(start[0], start[1]);
    else if (!this.current || !this.open) this.moveTo(start[0], start[1]);
    for (let i = 0; i < n; i++) {
      const b1 = a1 + ((a2 - a1) * i) / n;
      const b2 = a1 + ((a2 - a1) * (i + 1)) / n;
      const k = (4 / 3) * Math.tan((b2 - b1) / 4);
      const p = at(b1), q = at(b2);
      this.curveTo(p[0] - k * r * Math.sin(b1), p[1] + k * r * Math.cos(b1), q[0] + k * r * Math.sin(b2), q[1] - k * r * Math.cos(b2), q[0], q[1]);
    }
    return this;
  }
}

const end = (s: Subpath): Pt => {
  const c = s.cubics[s.cubics.length - 1];
  return [c[6], c[7]];
};
const degenerate = (c: Cubic) => c.every((v, i) => i < 2 || v === c[i % 2]);

export const path = () => new PathBuilder();
