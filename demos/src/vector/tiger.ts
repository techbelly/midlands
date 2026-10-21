// The Ghostscript Tiger demo, host side — ported from chari/web (tiger.ts +
// tiger-draw.ts + render.ts), adapted to Umgeni's flat tokens: a cubic is
// 8 numbers, a span is 4. All geometry (transform, cubic flattening, stroke
// expansion, clipping, rasterization) runs in compiled Nile — gezira's own
// stroke/bezier/rasterize source plus nl/vector.nl; this module does only
// SVG→cubics and span→pixel compositing. DOM-free: shared by the browser demo and tests.

import type { Op, Token } from '../../../umgeni/src/runtime.js';

export type Cubic = number[]; // 8 floats: A B C D as x,y pairs

export interface TigerPath {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  cubics: Cubic[]; // every subpath closed: the fill geometry
  subpaths: Cubic[][]; // as drawn: closed only by Z — the stroke geometry
}

export interface Tiger {
  matrix: number[]; // root transform [a,b,c,d,e,f]
  paths: TigerPath[];
}

// --- SVG parsing (regex-based; runs anywhere) --------------------------------

const attr = (s: string, name: string): string | null => {
  const m = s.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
};

function parseMatrix(t: string | null): number[] {
  const m = t?.match(/matrix\(([^)]*)\)/);
  return m ? m[1].split(/[\s,]+/).map(Number) : [1, 0, 0, 1, 0, 0];
}

const norm = (c: string | null): string | null => (c && c.toLowerCase() !== 'none' ? c : null);

// A straight segment as a degenerate cubic (controls at 1/3, 2/3 so
// FlattenCubics passes it through in one step).
const lineCubic = (x0: number, y0: number, x1: number, y1: number): Cubic => {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return [x0, y0, x0 + dx / 3, y0 + dy / 3, x0 + (2 * dx) / 3, y0 + (2 * dy) / 3, x1, y1];
};

const TOKENS = /([MmLlHhVvCcSsZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;

// Interpret an SVG path `d` into absolute cubics; subpaths are closed so the
// winding rasterizer fills them.
export const pathCubics = (d: string): Cubic[] => parsePath(d, true).flat();

// Subpaths as SVG strokes them: a closing segment only where `Z` says so.
export const pathSubpaths = (d: string): Cubic[][] => parsePath(d, false);

function parsePath(d: string, closeAll: boolean): Cubic[][] {
  const toks: string[] = [];
  let t: RegExpExecArray | null;
  TOKENS.lastIndex = 0;
  while ((t = TOKENS.exec(d))) toks.push(t[0]);

  const subs: Cubic[][] = [];
  let out: Cubic[] = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  let cpx = 0, cpy = 0;
  let open = false;
  let prevCmd = '';
  let i = 0;
  const num = () => Number(toks[i++]);
  const isCmd = (s: string) => /[A-Za-z]/.test(s);

  const closeSub = (z = false) => {
    if (open && (closeAll || z) && (x !== sx || y !== sy)) out.push(lineCubic(x, y, sx, sy));
    if (out.length > 0) subs.push(out);
    out = [];
    x = sx;
    y = sy;
  };
  const line = (nx: number, ny: number) => {
    out.push(lineCubic(x, y, nx, ny));
    x = nx;
    y = ny;
    open = true;
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    out.push([x, y, x1, y1, x2, y2, ex, ey]);
    cpx = x2;
    cpy = y2;
    x = ex;
    y = ey;
    open = true;
  };

  while (i < toks.length) {
    let cmd = toks[i];
    if (isCmd(cmd)) i++;
    else cmd = prevCmd === 'M' ? 'L' : prevCmd === 'm' ? 'l' : prevCmd;
    const rel = cmd >= 'a';
    switch (cmd.toUpperCase()) {
      case 'M': {
        if (open) closeSub();
        const nx = num(), ny = num();
        x = sx = rel ? x + nx : nx;
        y = sy = rel ? y + ny : ny;
        open = false;
        break;
      }
      case 'L': {
        const nx = num(), ny = num();
        line(rel ? x + nx : nx, rel ? y + ny : ny);
        break;
      }
      case 'H': {
        const nx = num();
        line(rel ? x + nx : nx, y);
        break;
      }
      case 'V': {
        const ny = num();
        line(x, rel ? y + ny : ny);
        break;
      }
      case 'C': {
        const a = num(), b = num(), c = num(), dd = num(), e = num(), f = num();
        cubic(rel ? x + a : a, rel ? y + b : b, rel ? x + c : c, rel ? y + dd : dd, rel ? x + e : e, rel ? y + f : f);
        break;
      }
      case 'S': {
        const refl = /[CcSs]/.test(prevCmd);
        const x1 = refl ? 2 * x - cpx : x;
        const y1 = refl ? 2 * y - cpy : y;
        const c = num(), dd = num(), e = num(), f = num();
        cubic(x1, y1, rel ? x + c : c, rel ? y + dd : dd, rel ? x + e : e, rel ? y + f : f);
        break;
      }
      case 'Z':
        closeSub(true);
        open = false;
        break;
      default:
        i++;
    }
    prevCmd = cmd;
  }
  if (open) closeSub();
  return subs;
}

export function parseTiger(svg: string): Tiger {
  const matrix = parseMatrix(svg.match(/<g\b[^>]*\btransform\s*=\s*"([^"]*)"/)?.[1] ?? null);
  const paths: TigerPath[] = [];
  const re = /<g\b([^>]*)>\s*<path\b([^>]*?)\/>\s*<\/g>/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const g = m[1], p = m[2];
    const d = attr(p, 'd');
    if (!d) continue;
    paths.push({
      fill: norm(attr(p, 'fill') ?? attr(g, 'fill')),
      stroke: norm(attr(p, 'stroke') ?? attr(g, 'stroke')),
      strokeWidth: Number(attr(p, 'stroke-width') ?? attr(g, 'stroke-width') ?? '1'),
      cubics: pathCubics(d),
      subpaths: pathSubpaths(d),
    });
  }
  return { matrix, paths };
}

// --- span compositing ---------------------------------------------------------

export type RGB = readonly [number, number, number];

export function hexRGB(hex: string): RGB {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as RGB;
}

export interface ImgLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | number[];
}

// Composite CoverageSpans (flat [x, y, c, l]) over the image in `color`.
// Span coordinates are pixel centres (n + 0.5), so they FLOOR to pixel n —
// the same convention as paintCoverage and the GPU grid. (chari's original
// rounded, shifting its whole image by one pixel, self-consistently.)
export function paintSpans(img: ImgLike, spans: number[][], color: RGB): void {
  const { width, height, data } = img;
  for (const [x, y, c, l] of spans) {
    const cov = Math.min(1, Math.abs(c));
    if (cov <= 0) continue;
    const yi = Math.floor(y);
    if (yi < 0 || yi >= height) continue;
    const len = Math.max(1, Math.round(l));
    const x0 = Math.floor(x);
    for (let i = 0; i < len; i++) {
      const xi = x0 + i;
      if (xi < 0 || xi >= width) continue;
      const idx = (yi * width + xi) * 4;
      data[idx] = color[0] * cov + (data[idx] as number) * (1 - cov);
      data[idx + 1] = color[1] * cov + (data[idx + 1] as number) * (1 - cov);
      data[idx + 2] = color[2] * cov + (data[idx + 2] as number) * (1 - cov);
      data[idx + 3] = 255;
    }
  }
}

export function collectSpans(op: Op, tokens: Token[]): number[][] {
  const spans: number[][] = [];
  op.setEmit((t) => spans.push(t));
  for (const t of tokens) op.push(t);
  op.end();
  return spans;
}

// --- the tiger driver -----------------------------------------------------------

export type ProcessFactory = (params?: number[]) => Op;
export type Registry = { [name: string]: ProcessFactory } | Map<string, ProcessFactory>;

const get = (r: Registry, name: string): ProcessFactory => {
  const f = r instanceof Map ? r.get(name) : r[name];
  if (!f) throw new Error(`registry has no '${name}'`);
  return f;
};

// Compose affine transforms: result applies `b` then `a`.
export function mul(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

// Fit the tiger's 900×900 viewBox into W×H.
export function fitView(W: number, H: number): number[] {
  const s = Math.min(W, H) / 900;
  return [s, 0, 0, s, (W - 900 * s) / 2, (H - 900 * s) / 2];
}

// SVG's stroke defaults: miter joins with limit 4, butt caps. (gezira:
// join l < 0 is round, otherwise a miter with that limit; cap c < 0 is round,
// otherwise a square extension of c × half-width, so 0 is butt.)
export const SVG_JOIN = 4;
export const SVG_CAP = 0;

// A stroke's outline: gezira's StrokeBezierPath, unmodified, run once per
// subpath (its end of stream is where it caps or closes the path). The
// result is flat beziers, filled together so overlaps aren't double-painted.
export function strokeOutline(
  registry: Registry, m: number[], w: number, join: number, cap: number, subpaths: Cubic[][],
): number[][] {
  const outline = get(registry, 'StrokeOutline');
  return subpaths.flatMap((sub) => collectSpans(outline([...m, w, join, cap]), sub));
}

// The GPU front half: run each path's geometry (transform → flatten →
// [stroke] → clip, compiled Nile on the CPU) and return flat bezier batches
// with normalized colors, ready for the GPU rasterizer+compositor.
export interface PathBatch {
  beziers: Float32Array<ArrayBuffer>;
  n: number;
  color: readonly [number, number, number];
}

export function tigerBatches(
  tiger: Tiger,
  view: number[],
  registry: Registry,
  clipW: number,
  clipH: number,
  minStroke = 0.75,
): PathBatch[] {
  const m = mul(view, tiger.matrix);
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const clip = [0, 0, clipW, clipH];
  const transform = get(registry, 'TransformCubics');
  const flatten = get(registry, 'FlattenCubics');
  const clipK = get(registry, 'ClipBeziers');
  const batches: PathBatch[] = [];
  const push = (beziers: number[][], hex: string) => {
    if (beziers.length === 0) return;
    const [r, g, b] = hexRGB(hex);
    batches.push({ beziers: new Float32Array(beziers.flat()), n: beziers.length, color: [r / 255, g / 255, b / 255] });
  };
  const clipped = (beziers: number[][]) => collectSpans(clipK(clip), beziers);

  for (const path of tiger.paths) {
    if (path.fill) {
      const flat = collectSpans(flatten(), collectSpans(transform(m), path.cubics));
      push(clipped(flat), path.fill);
    }
    if (path.stroke) {
      const w = Math.max(minStroke, path.strokeWidth * scale);
      push(clipped(strokeOutline(registry, m, w, SVG_JOIN, SVG_CAP, path.subpaths)), path.stroke);
    }
  }
  return batches;
}

// Returns the number of paths drawn. Everything geometric runs in compiled
// Nile — gezira's own kernels plus nl/vector.nl; clip bounds = the canvas.
export function drawTiger(
  img: ImgLike,
  tiger: Tiger,
  view: number[],
  registry: Registry,
  minStroke = 0.75,
): number {
  const m = mul(view, tiger.matrix);
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const clip = [0, 0, img.width, img.height];
  const fill = get(registry, 'FillPath');
  const fillBeziers = get(registry, 'FillBeziers');
  for (const path of tiger.paths) {
    if (path.fill) {
      paintSpans(img, collectSpans(fill([...m, ...clip]), path.cubics), hexRGB(path.fill));
    }
    if (path.stroke) {
      const w = Math.max(minStroke, path.strokeWidth * scale);
      const outline = strokeOutline(registry, m, w, SVG_JOIN, SVG_CAP, path.subpaths);
      paintSpans(img, collectSpans(fillBeziers(clip), outline), hexRGB(path.stroke));
    }
  }
  return tiger.paths.length;
}
