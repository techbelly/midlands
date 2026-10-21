// SVG → cubics: the subset the Ghostscript tiger uses (a root `matrix(…)`
// transform; <g> groups each holding one <path> with fill / stroke /
// stroke-width; path commands M L H V C S Z, absolute and relative).
// Regex-based, DOM-free: runs in the browser and in tests.

export type Cubic = number[]; // 8 floats: A B C D as x,y pairs

export interface SvgPath {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  cubics: Cubic[]; // every subpath closed: the fill geometry
  subpaths: Cubic[][]; // as drawn: closed only by Z — the stroke geometry
}

export interface Svg {
  matrix: number[]; // root transform [a,b,c,d,e,f]
  paths: SvgPath[];
}

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

export function parseSvg(svg: string): Svg {
  const matrix = parseMatrix(svg.match(/<g\b[^>]*\btransform\s*=\s*"([^"]*)"/)?.[1] ?? null);
  const paths: SvgPath[] = [];
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
