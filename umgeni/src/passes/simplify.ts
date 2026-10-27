// Two small scalar clean-ups around CSE, each a walk over a kernel's
// statements.
//
//   fold    an operation on constants is the constant: the Bézier midpoint's
//           `1 / 2`, a select on a literal condition. Folding runs before CSE
//           so that keys match on the folded form, and uses the same functions
//           as the interpreter (scalar.ts), so the compiled result stays bit
//           for bit the interpreter's. A result that is not finite is left as
//           written: the back ends spell NaN and infinity differently, or not
//           at all.
//   prune   a let nobody reads or assigns is dropped: a destructured field
//           that went unused, a shared value whose users were themselves
//           pruned. Expressions are pure, so nothing is lost. Runs after CSE,
//           to a fixed point, since a dead let's expression may have been the
//           only reader of another.

import { BIN, UN } from '../scalar.js';
import { allStmts, localReads, mapKernels, mapRegions, mapStmts, operands, withOperands, type KernelIR, type ModuleIR, type ScalarExpr, type Stmt } from '../ir.js';

export const foldModule = (mod: ModuleIR): ModuleIR => mapKernels(mod, foldKernel);
export const pruneModule = (mod: ModuleIR): ModuleIR => mapKernels(mod, pruneKernel);

// --- fold ---

function foldKernel(k: KernelIR): KernelIR {
  return mapRegions({ ...k, stateInit: k.stateInit.map(fold) }, (stmts) => mapStmts(stmts, fold));
}

const isConst = (e: ScalarExpr): e is { k: 'const'; value: number } => e.k === 'const';
const num = (value: number): ScalarExpr | null => (Number.isFinite(value) ? { k: 'const', value } : null);

export function fold(e: ScalarExpr): ScalarExpr {
  const xs = operands(e);
  if (xs.length === 0) return e;
  const ys = xs.map(fold);
  const folded = withOperands(e, ys);
  switch (folded.k) {
    case 'bin': return (isConst(folded.a) && isConst(folded.b) && num(BIN[folded.op].f(folded.a.value, folded.b.value))) || folded;
    case 'un': return (isConst(folded.a) && num(UN[folded.op].f(folded.a.value))) || folded;
    case 'select': return isConst(folded.cond) ? (folded.cond.value !== 0 ? folded.then : folded.else) : folded;
    default: return folded;
  }
}

// --- prune ---

const pruneKernel = (k: KernelIR): KernelIR => mapRegions(k, pruneRegion);

// Locals are per region (a prologue, a body and a flush are separate
// scopes), and a name is bound once in a region, so reads and assigns are
// counted over the whole region.
function pruneRegion(stmts: Stmt[]): Stmt[] {
  for (;;) {
    const live = localReads(stmts);
    for (const s of allStmts(stmts)) if (s.k === 'assign') live.set(s.name, 1);
    let dropped = false;
    const prune = (ss: Stmt[]): Stmt[] =>
      ss.flatMap((s): Stmt[] => {
        if (s.k === 'let' && !live.has(s.name)) { dropped = true; return []; }
        if (s.k === 'if') return [{ ...s, then: prune(s.then), else: prune(s.else) }];
        return [s];
      });
    stmts = prune(stmts);
    if (!dropped) return stmts;
  }
}
