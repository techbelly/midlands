// Extended Nile's scans and windows are sugar: sugar.mooi rewrites them into
// core Nile (state, primed updates, ifs) and returns what they declared —
// a parallel backend lowers by the declaration (docs/access-patterns.md).

import type * as A from '../ast.js';
import { load } from '../../../mooi/src/mooi.js';
import { prelude } from '../../../mooi/src/prelude.js';
import { sugarSource } from './source.js';

export interface Declared {
  scan?: { key: string; op: string; identity: number };
  window?: { key: string | null };
}

export class SugarError extends Error {}

const m = load(sugarSource, prelude((msg) => {
  throw new SugarError(msg);
})) as { desugar: (k: A.Kernel, fieldsOf: unknown) => { kernel: A.Kernel; declared: Declared } };

// `fieldsOf` names a record type's top-level fields (types are resolved by
// the elaborator).
export const desugar = (k: A.Kernel, fieldsOf: (t: A.Type) => string[]) => m.desugar(k, fieldsOf);
