// Drawing with a compiled Nile library (nile = api(registry), or
// library.api): each process by name, its parameters by name, and
// .run(tokens) to push a stream through it and collect what it emits.

import type { Api } from '../../../umgeni/src/cpu/runtime.js';
import type { Cubic } from './svg.js';

export type { Api } from '../../../umgeni/src/cpu/runtime.js';

// A stroke's outline: gezira's StrokeBezierPath, unmodified, run once per
// subpath (its end of stream is where it caps or closes the path). The
// result is flat beziers, filled together so overlaps aren't double-painted.
export function strokeOutline(nile: Api, m: number[], w: number, join: number, cap: number, subpaths: Cubic[][]): number[][] {
  return subpaths.flatMap((sub) => nile.StrokeOutline({ M: m, w, l: join, c: cap }).run(sub));
}
