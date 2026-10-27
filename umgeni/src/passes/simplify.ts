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
import { mapKernels, operands, withOperands, type KernelIR, type ModuleIR, type ScalarExpr, type Stmt } from '../ir.js';

export const foldModule = (mod: ModuleIR): ModuleIR => mapKernels(mod, foldKernel);
export const pruneModule = (mod: ModuleIR): ModuleIR => mapKernels(mod, pruneKernel);

// --- walking ---

// The same statements with every expression rewritten.
function mapStmts(stmts: Stmt[], f: (e: ScalarExpr) => ScalarExpr): Stmt[] {
  return stmts.map((s): Stmt => {
    switch (s.k) {
      case 'let': case 'assign': case 'setState': return { ...s, expr: f(s.expr) };
      case 'emit': case 'feed': return { ...s, values: s.values.map(f) };
      case 'if': return { ...s, cond: f(s.cond), then: mapStmts(s.then, f), else: mapStmts(s.else, f) };
    }
  });
}

const regions = ['prologue', 'body', 'flush'] as const;

// --- fold ---

function foldKernel(k: KernelIR): KernelIR {
  return { ...k, stateInit: k.stateInit.map(fold), prologue: mapStmts(k.prologue, fold), body: mapStmts(k.body, fold), flush: mapStmts(k.flush, fold) };
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

function pruneKernel(k: KernelIR): KernelIR {
  const out = { ...k };
  for (const r of regions) out[r] = pruneRegion(k[r]);
  return out;
}

// Locals are per region (a prologue, a body and a flush are separate
// scopes), and a name is bound once in a region, so reads and assigns are
// counted over the whole region.
function pruneRegion(stmts: Stmt[]): Stmt[] {
  for (;;) {
    const live = new Set<string>();
    const note = (e: ScalarExpr): ScalarExpr => {
      if (e.k === 'local') live.add(e.name);
      else operands(e).forEach(note);
      return e;
    };
    const scan = (ss: Stmt[]): void => {
      for (const s of ss) {
        if (s.k === 'assign') live.add(s.name);
        mapStmts([s], note);
      }
      for (const s of ss) if (s.k === 'if') { scan(s.then); scan(s.else); }
    };
    scan(stmts);
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
