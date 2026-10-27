// SVG → cubics: the subset the Ghostscript tiger uses (a root `matrix(…)`
// transform; <g> groups each holding one <path> with fill / stroke /
// stroke-width; path commands M L H V C S Z, absolute and relative).
// Regex-based, DOM-free: runs in the browser and in tests. The path
// commands are interpreted in Nile (nl/svg.nl), so parsing takes the
// compiled vector library.

import { IDENTITY, type Api } from './draw.js';

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
  return m ? m[1].split(/[\s,]+/).map(Number) : [...IDENTITY];
}

const norm = (c: string | null): string | null => (c && c.toLowerCase() !== 'none' ? c : null);

// Lexing is the host's part: `d` → one PathCommand token per command as
// written, implicit repeats made explicit (after M they are L). What the
// commands mean is Nile's part (nl/svg.nl, PathCubics).
const TOKENS = /([MmLlHhVvCcSsZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Z: 0 };

export function pathCommands(nile: Api, d: string): number[][] {
  const { PathCommand } = nile.types;
  const toks = d.match(TOKENS) ?? [];
  const out: number[][] = [];
  let prev = '';
  for (let i = 0; i < toks.length; ) {
    let cmd = toks[i];
    if (/[A-Za-z]/.test(cmd)) i++;
    else if (prev === '' || /[Zz]/.test(prev)) { i++; continue; } // stray number
    else cmd = prev === 'M' ? 'L' : prev === 'm' ? 'l' : prev;
    const op = cmd.toUpperCase();
    const args = toks.slice(i, i + ARITY[op]).map(Number);
    i += ARITY[op];
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = args;
    out.push(PathCommand.make({ op: 'MLHVCSZ'.indexOf(op) + 1, rel: cmd === op ? 0 : 1, a, b, c, d, e, f }));
    prev = cmd;
  }
  return out;
}

// Every subpath closed: the fill geometry, each PathCubic's cubic Z.
export function pathCubics(nile: Api, d: string): Cubic[] {
  const { PathCubic } = nile.types;
  return nile.PathCubics({ closeAll: 1 }).run(pathCommands(nile, d)).map((t) => PathCubic.get(t, 'Z') as Cubic);
}

// Subpaths as SVG strokes them: a closing segment only where `Z` says so.
// Each PathCubic carries its subpath's number n.
export function pathSubpaths(nile: Api, d: string): Cubic[][] {
  const { PathCubic } = nile.types;
  const subpaths = new Map<number, Cubic[]>();
  for (const t of nile.PathCubics({ closeAll: 0 }).run(pathCommands(nile, d))) {
    const n = PathCubic.get(t, 'n') as number;
    subpaths.set(n, [...(subpaths.get(n) ?? []), PathCubic.get(t, 'Z') as Cubic]);
  }
  return [...subpaths.values()];
}

export function parseSvg(svg: string, nile: Api): Svg {
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
      cubics: pathCubics(nile, d),
      subpaths: pathSubpaths(nile, d),
    });
  }
  return { matrix, paths };
}
