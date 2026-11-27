// Text that finds the pixel grid, host side (no DOM: shared by the page and
// its test).
//
// A line of text is set down wherever it falls, a fraction of a pixel off
// the grid each way, and its outlines are allowed one kind of movement: a
// warp of each axis. There is a knot on every pixel line, across and down;
// each knot may slide along its axis, and a point of the outline moves with
// the two knots it lies between, in proportion. So a stem keeps its straight
// sides and a row of letters shares one baseline, whatever the knots do.
//
// The outlines are rasterized by a Nile library compiled as its own
// derivative (compileLibrary with `directions`), a direction to a knot, so
// every pixel comes back with how its coverage changes as each knot slides.
// Nothing in the Nile knows this is happening.
//
// A line has hundreds of knots and a letter lies among a few of them. So
// each letter is rasterized by itself, with a direction for each knot it
// lies among and no others, and the pictures are added: letters do not
// cover one another, so the sum is the line's picture, and each letter's
// slopes go to the line's knots they belong to. A knot between two letters
// hears from both. That is what lets a line be any length, where the
// compiled derivative's tokens can be only so wide.
//
// What the host adds is what to want. Grey is the sum over the picture of
// c (1 - c), which is nothing for a pixel wholly inked or wholly clear and
// most for one half covered: that is brought down. Left at that, the letters
// would close up into slabs, which are sharper than letters. So two things
// hold them: the picture, blurred a pixel each way, is to stay what it was
// (`keep`), and neighbouring knots are to slide together (`even`). The step
// is Adam's, and it shortens as it goes, since grey has a corner wherever an
// edge meets a pixel line, and that is where the edges are going.

import type { CompiledLibrary } from '../../../umgeni/src/compile.js';
import type { Font } from '../text/ttf.js';

// A line of text in pixels: each letter's beziers, set down a fraction of a
// pixel off the grid each way, in a picture of its own, `row` rows down the
// page.
export interface Line {
  letters: number[][][];
  width: number;
  height: number;
  row: number;
  shown: string;
}

// Text set as lines no wider than `width` pixels, broken at spaces, the
// first `at` (a fraction of a pixel each way) from one pixel in. The lines
// are a line height apart, which is seldom a whole number of pixels, so
// each falls its own fraction of a pixel down its rows.
export function setLines(font: Font, text: string, size: number, at: number[], width: number): Line[] {
  const left = 1 + at[0];
  const wide = (s: string) => [...s].reduce((sum, ch) => sum + font.glyphFor(ch).advance * size, 0);
  const rows: string[] = [];
  let row = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const longer = row ? `${row} ${word}` : word;
    if (row && left + wide(longer) + 1.5 > width) (rows.push(row), row = word);
    else row = longer;
  }
  if (row) rows.push(row);
  return rows.map((shown, i) => {
    const down = 1 + at[1] + i * font.lineHeight * size;
    const first = Math.floor(down) - 1;
    const top = down - first;
    const letters: number[][][] = [];
    let pen = left;
    for (const ch of shown) {
      const g = font.glyphFor(ch);
      if (g.beziers.length > 0) letters.push(g.beziers.map((b) => b.map((v, k) => (k % 2 === 0 ? pen + v * size : top + v * size))));
      pen += g.advance * size;
    }
    return { letters, width: Math.ceil(pen + 1.5), height: Math.ceil(top + font.lineHeight * size + 1), row: first, shown };
  });
}

// The knots a letter lies among: from the pixel line at or before its
// least coordinate to the one after its greatest, across and down.
function among(letter: number[][], line: { width: number; height: number }): { x0: number; nx: number; y0: number; ny: number } {
  const span = (c: number, most: number): [number, number] => {
    const cells = letter.flatMap((b) => [b[c], b[c + 2], b[c + 4]]).map((v) => Math.min(Math.max(Math.floor(v), 0), most - 1));
    const lo = Math.min(...cells);
    return [lo, Math.max(...cells) + 2 - lo];
  };
  const [x0, nx] = span(0, line.width), [y0, ny] = span(1, line.height);
  return { x0, nx, y0, ny };
}

// How many directions the rasterizer's derivative must have for these
// lines: the most knots any one letter lies among.
export const directionsFor = (lines: Line[]): number =>
  Math.max(1, ...lines.flatMap((line) => line.letters.map((l) => { const a = among(l, line); return a.nx + a.ny; })));

export interface HintOptions {
  keep: number;     // how much the blurred picture is to stay what it was
  even: number;     // how much neighbouring knots are to slide together
  steps?: number;
}

export interface Hint {
  readonly before: Float64Array;    // the line's picture as it was set down, width × height
  readonly coverage: Float64Array;  // its picture as it is now
  readonly slide: Float64Array;     // how far each knot has slid: those across, then those down
  readonly across: number;          // how many of the knots are across
  readonly step: number;
  readonly settled: boolean;
  readonly grey: number;            // the sum of c (1 - c) now
  readonly away: number;            // how far the blurred picture is from what it was, squared and summed
  readonly wanted: number;          // all that is brought down: the grey, and what holds the letters
  readonly gradient: Float64Array;  // how that changes as each knot slides
  advance(): void;                  // one step downhill
  slideTo(knot: number, to: number): void; // a knot taken somewhere by hand
  beziers(): number[][];            // the outlines where the knots have taken them
}

// The strip of picture a pair of knots is weighed against: a line's height,
// near enough, so that knots across count for about one each.
const STRIP = 20;

export const grey = (c: Float64Array): number => c.reduce((sum, v) => sum + v * (1 - v), 0);
export const ink = (c: Float64Array): number => c.reduce((sum, v) => sum + v, 0);

// `library` is the rasterizer as its own derivative in `directions`
// directions, at least directionsFor([line]) of them.
export function createHint(library: CompiledLibrary, directions: number, line: Line, opts: HintOptions): Hint {
  const { width, height } = line;
  const { keep, even } = opts;
  const steps = opts.steps ?? 300;
  const nx = width + 1, n = nx + height + 1;
  const slide = new Float64Array(n);
  const momentum = new Float64Array(n), spread = new Float64Array(n);
  let step = 0;
  let coverage = new Float64Array(width * height);
  let gradient = new Float64Array(n);
  let away = 0;
  let uneven = 0;

  // The two knots a coordinate lies between, and its share of the second.
  const between = (v: number, i: number): [number, number] => {
    const k = Math.min(Math.max(Math.floor(v), 0), (i % 2 === 0 ? width : height) - 1);
    return [(i % 2 === 0 ? 0 : nx) + k, v - k];
  };
  const warped = (b: number[]): number[] => b.map((v, i) => {
    const [k, f] = between(v, i);
    return v + slide[k] * (1 - f) + slide[k + 1] * f;
  });

  // Each letter with the line's knots its directions are, and each of its
  // beziers with how it moves as each of those slides: that part never
  // changes, so it is made once and the values put in.
  const letters = line.letters.map((beziers) => {
    const a = among(beziers, line);
    if (a.nx + a.ny > directions) throw new Error(`a letter among ${a.nx + a.ny} knots wants as many directions, and the library has ${directions}`);
    const knot = [...Array.from({ length: a.nx }, (_, j) => a.x0 + j), ...Array.from({ length: a.ny }, (_, j) => nx + a.y0 + j)];
    const local = (k: number) => (k < nx ? k - a.x0 : a.nx + k - nx - a.y0);
    const moves = beziers.map((b) => {
      const t = new Array<number>(6 * (1 + directions)).fill(0);
      b.forEach((v, i) => {
        const [k, f] = between(v, i);
        t[6 * (local(k) + 1) + i] = 1 - f;
        t[6 * (local(k + 1) + 1) + i] = f;
      });
      return t;
    });
    return { beziers, knot, moves };
  });
  const tokens = (letter: (typeof letters)[number]): number[][] => letter.beziers.map((b, i) => {
    const t = letter.moves[i].slice(); // a new array each run: the runtime keeps what it was given
    warped(b).forEach((v, k) => (t[k] = v));
    return t;
  });

  // A pixel each way, as a box: what the picture is from a little way off.
  const blurred = (a: Float64Array): Float64Array => {
    const pass = (src: Float64Array, dx: number, dy: number): Float64Array => {
      const out = new Float64Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let sum = 0;
          for (let k = -1; k <= 1; k++) {
            const xx = x + k * dx, yy = y + k * dy;
            if (xx >= 0 && yy >= 0 && xx < width && yy < height) sum += src[yy * width + xx];
          }
          out[y * width + x] = sum / 3;
        }
      }
      return out;
    };
    return pass(pass(a, 1, 0), 0, 1);
  };

  let far0: Float64Array | null = null;

  // The picture as it is, and which way is down.
  function look(): void {
    const each = (spans: number[][], f: (s: number[], at: number) => void) => {
      for (const s of spans) {
        const y = Math.floor(s[1]);
        if (y < 0 || y >= height) continue;
        for (let i = 0; i < s[3]; i++) {
          const x = Math.floor(s[0]) + i;
          if (x >= 0 && x < width) f(s, y * width + x);
        }
      }
    };
    const rasterize = library.api.RasterizeExact;
    const drawn = letters.map((letter) => rasterize().run(tokens(letter)));
    // Where two letters do meet in a pixel and fill it between them, it is
    // full, and stays full however either moves.
    const sum = new Float64Array(width * height);
    for (const spans of drawn) each(spans, (s, at) => (sum[at] += s[2]));
    coverage = sum.map((c) => Math.min(c, 1));
    const far = blurred(coverage);
    far0 ??= far;
    const moved = new Float64Array(width * height);
    away = 0;
    for (let i = 0; i < width * height; i++) {
      moved[i] = far[i] - far0[i];
      away += moved[i] * moved[i];
    }
    // The blur is the same seen from either side, so what each pixel is to
    // answer for of the blurred difference is that difference blurred.
    const answer = blurred(moved);
    gradient = new Float64Array(n);
    drawn.forEach((spans, l) => {
      const knot = letters[l].knot;
      each(spans, (s, at) => {
        if (sum[at] > 1) return;
        const e = 1 - 2 * coverage[at] + 2 * keep * answer[at];
        for (let j = 0; j < knot.length; j++) {
          const d = s[4 * (j + 1) + 2]; // direction j's copy of c
          if (d !== 0) gradient[knot[j]] += e * d;
        }
      });
    });
    // Two knots sliding apart stretch the strip of the picture between
    // them, and the more of the picture that is, the more it counts: a strip
    // across the whole of a long line more than one down a letter.
    uneven = 0;
    for (const [from, to, strip] of [[0, nx, height / STRIP], [nx, n, width / STRIP]]) {
      for (let k = from; k + 1 < to; k++) {
        const apart = slide[k + 1] - slide[k];
        uneven += strip * apart * apart;
        gradient[k] -= 2 * even * strip * apart;
        gradient[k + 1] += 2 * even * strip * apart;
      }
    }
  }

  look();
  const before = coverage;
  return {
    before,
    get coverage() { return coverage; },
    get slide() { return slide; },
    across: nx,
    get step() { return step; },
    get settled() { return step >= steps; },
    get grey() { return grey(coverage); },
    get away() { return away; },
    get wanted() { return grey(coverage) + keep * away + even * uneven; },
    get gradient() { return gradient; },
    advance() {
      step++;
      const rate = 0.04 * Math.max(0.02, 1 - step / steps);
      for (let j = 0; j < n; j++) {
        momentum[j] = 0.9 * momentum[j] + 0.1 * gradient[j];
        spread[j] = 0.999 * spread[j] + 0.001 * gradient[j] * gradient[j];
        slide[j] -= (rate * (momentum[j] / (1 - 0.9 ** step))) / (Math.sqrt(spread[j] / (1 - 0.999 ** step)) + 1e-8);
      }
      look();
    },
    slideTo(knot, to) {
      slide[knot] = to;
      look();
    },
    beziers: () => line.letters.flat().map(warped),
  };
}
