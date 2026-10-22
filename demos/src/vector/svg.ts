// SVG → cubics: the subset the Ghostscript tiger uses (a root `matrix(…)`
// transform; <g> groups each holding one <path> with fill / stroke /
// stroke-width; path commands M L H V C S Z, absolute and relative).
// Regex-based, DOM-free: runs in the browser and in tests. The path
// commands are interpreted in Nile (nl/svg.nl), so parsing takes the
// compiled vector registry.

import { collectSpans, get, type Registry } from './draw.js';

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

// Lexing is the host's part: `d` → one PathCommand token per command as
// written, implicit repeats made explicit (after M they are L). What the
// commands mean is Nile's part (nl/svg.nl, PathCubics).
const TOKENS = /([MmLlHhVvCcSsZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Z: 0 };

export function pathCommands(d: string): number[][] {
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
    out.push(['MLHVCSZ'.indexOf(op) + 1, cmd === op ? 0 : 1, ...args, 0, 0, 0, 0, 0, 0].slice(0, 8));
    prev = cmd;
  }
  return out;
}

// Every subpath closed: the fill geometry.
export const pathCubics = (registry: Registry, d: string): Cubic[] =>
  collectSpans(get(registry, 'PathCubics')({ closeAll: 1 }), pathCommands(d)).map((t) => t.slice(0, 8));

// Subpaths as SVG strokes them: a closing segment only where `Z` says so.
export function pathSubpaths(registry: Registry, d: string): Cubic[][] {
  const subpaths = new Map<number, Cubic[]>();
  for (const t of collectSpans(get(registry, 'PathCubics')({ closeAll: 0 }), pathCommands(d))) {
    subpaths.set(t[8], [...(subpaths.get(t[8]) ?? []), t.slice(0, 8)]);
  }
  return [...subpaths.values()];
}

export function parseSvg(svg: string, registry: Registry): Svg {
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
      cubics: pathCubics(registry, d),
      subpaths: pathSubpaths(registry, d),
    });
  }
  return { matrix, paths };
}
