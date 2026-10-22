// Driving compiled Nile processes from the host: look one up in a registry,
// push tokens through it, collect what it emits.

import type { Op, Params, Token } from '../../../umgeni/src/cpu/runtime.js';
import type { Cubic } from './svg.js';

export type ProcessFactory = (params?: Params) => Op;
export type Registry = { [name: string]: ProcessFactory } | Map<string, ProcessFactory>;

export const get = (r: Registry, name: string): ProcessFactory => {
  const f = r instanceof Map ? r.get(name) : r[name];
  if (!f) throw new Error(`registry has no '${name}'`);
  return f;
};

export function collectSpans(op: Op, tokens: Token[]): number[][] {
  const spans: number[][] = [];
  op.setEmit((t) => spans.push(t));
  for (const t of tokens) op.push(t);
  op.end();
  return spans;
}

// A stroke's outline: gezira's StrokeBezierPath, unmodified, run once per
// subpath (its end of stream is where it caps or closes the path). The
// result is flat beziers, filled together so overlaps aren't double-painted.
export function strokeOutline(
  registry: Registry, m: number[], w: number, join: number, cap: number, subpaths: Cubic[][],
): number[][] {
  const outline = get(registry, 'StrokeOutline');
  return subpaths.flatMap((sub) => collectSpans(outline({ M: m, w, l: join, c: cap }), sub));
}
