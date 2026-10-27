// Common-subexpression elimination: block-scoped value numbering over the
// scalar IR. Elaboration duplicates expression trees freely (operator inlining
// substitutes argument trees at each parameter use; broadcast and guard
// lifting repeat expressions per record leaf); this pass shares them via lets.
//
// Why no SSA: the IR is already single-assignment except for the primed state
// locals ('assign'), and structured control flow gives dominator scoping for
// free — a table stack pushed/popped per branch is exactly dominator-scoped
// value numbering. Mutation is handled with epochs: each mutable name carries
// a version that is bumped on assignment and mixed into value keys, so an
// expression read before and after an assignment gets different keys.
//
// Conservative choices (documented misses): branch-local occurrences are not
// hoisted to the parent block; an expression duplicated across sibling
// branches is materialized in each.
//
// The counts are over the original trees, so when a whole tree is repeated,
// every subtree inside it counts as repeated too and is given a let of its
// own, though sharing the outer tree leaves each inner one a single reader.
// Half the lets came out that way, and a let costs: a comparison bound to a
// name must materialize as 1 or 0 and be tested again. So after the rewrite,
// a shared let read exactly once is put back where it is read. That read is
// always the first occurrence, in the statement the let was placed before,
// so nothing moves across an assignment.

import { allStmts, mapKernels, opCount, operands, withOperands, type KernelIR, type ModuleIR, type ScalarExpr, type Stmt } from '../ir.js';

export const cseModule = (mod: ModuleIR): ModuleIR => mapKernels(mod, cseKernel);

function cseKernel(p: KernelIR): KernelIR {
  return {
    ...p,
    prologue: cseRegion(p.prologue),
    body: cseRegion(p.body),
    flush: cseRegion(p.flush),
  };
}

// Materialize a shared subtree of at least this many ops. One: a single
// floor or subtraction repeated three times is three operations, and on the
// paragraph benchmark sharing them cut executed IR ops by a further 15% for
// 2% more generated text (it was 2, on the thought that a let is not worth
// a single add; the measurement said otherwise).
const MIN_OPS = 1;

// Versions of the mutable names, mixed into value keys: each assignment
// bumps one, so a read before and after it gets different keys. Both passes
// walk the same statements from a fresh Epochs, so their keys agree.
interface Epochs {
  locals: Map<string, number>; // primed state local -> version
  state: number;
}
const newEpochs = (): Epochs => ({ locals: new Map(), state: 0 });
function afterStmt(s: Stmt, ep: Epochs): void {
  if (s.k === 'assign') ep.locals.set(s.name, (ep.locals.get(s.name) ?? 0) + 1);
  if (s.k === 'setState') ep.state++;
}

interface Region {
  counts: Map<string, number>; // value key -> occurrences
  fresh: number;
}

function cseRegion(stmts: Stmt[]): Stmt[] {
  // Names start past any the region already has, so the pass can run again
  // over its own output (a let of the same name would merge the reads).
  let fresh = 0;
  for (const s of allStmts(stmts)) {
    const m = s.k === 'let' && /^#cse(\d+)$/.exec(s.name);
    if (m) fresh = Math.max(fresh, Number(m[1]) + 1);
  }
  const region: Region = { counts: new Map(), fresh };
  countStmts(stmts, region, newEpochs());
  return inlineSingleReads(rewriteStmts(stmts, region, newEpochs(), [new Map()]));
}

// --- pass 3: a shared let read once goes back to its reader ---

const isShared = (name: string): boolean => name.startsWith('#cse');

function inlineSingleReads(stmts: Stmt[]): Stmt[] {
  const reads = new Map<string, number>();
  const count = (e: ScalarExpr): void => {
    if (e.k === 'local') reads.set(e.name, (reads.get(e.name) ?? 0) + 1);
    else operands(e).forEach(count);
  };
  const countStmts = (ss: Stmt[]): void => {
    for (const s of ss) {
      switch (s.k) {
        case 'let': case 'assign': case 'setState': count(s.expr); break;
        case 'emit': case 'feed': s.values.forEach(count); break;
        case 'if': count(s.cond); countStmts(s.then); countStmts(s.else); break;
      }
    }
  };
  countStmts(stmts);
  const inlined = new Map<string, ScalarExpr>();
  const subst = (e: ScalarExpr): ScalarExpr => (e.k === 'local' ? (inlined.get(e.name) ?? e) : withOperands(e, operands(e).map(subst)));
  const rewrite = (ss: Stmt[]): Stmt[] =>
    ss.flatMap((s): Stmt[] => {
      switch (s.k) {
        case 'let': {
          const expr = subst(s.expr);
          if (isShared(s.name) && reads.get(s.name) === 1) { inlined.set(s.name, expr); return []; }
          return [{ ...s, expr }];
        }
        case 'assign': case 'setState': return [{ ...s, expr: subst(s.expr) }];
        case 'emit': case 'feed': return [{ ...s, values: s.values.map(subst) }];
        case 'if': return [{ ...s, cond: subst(s.cond), then: rewrite(s.then), else: rewrite(s.else) }];
      }
    });
  return rewrite(stmts);
}

// --- value keys (canonical, epoch-aware) ---

function key(e: ScalarExpr, ep: Epochs): string {
  switch (e.k) {
    case 'const':
      return `c${e.value}`;
    case 'param':
      return `p${e.index}`;
    case 'input':
      return `i${e.index}`;
    case 'state':
      return `s${e.index}@${ep.state}`;
    case 'local':
      return `l${e.name}@${ep.locals.get(e.name) ?? 0}`;
    case 'bin':
      return `(${key(e.a, ep)}${e.op}${key(e.b, ep)})`;
    case 'un':
      return `${e.op}(${key(e.a, ep)})`;
    case 'select':
      return `?(${key(e.cond, ep)};${key(e.then, ep)};${key(e.else, ep)})`;
  }
}

// --- pass 1: occurrence counts ---

function countExpr(e: ScalarExpr, r: Region, ep: Epochs): void {
  const xs = operands(e);
  if (xs.length === 0) return;
  for (const x of xs) countExpr(x, r, ep);
  const k = key(e, ep);
  r.counts.set(k, (r.counts.get(k) ?? 0) + 1);
}

function countStmts(stmts: Stmt[], r: Region, ep: Epochs): void {
  for (const s of stmts) {
    switch (s.k) {
      case 'let':
      case 'assign':
      case 'setState':
        countExpr(s.expr, r, ep);
        break;
      case 'emit':
      case 'feed':
        for (const v of s.values) countExpr(v, r, ep);
        break;
      case 'if':
        countExpr(s.cond, r, ep);
        countStmts(s.then, r, ep);
        countStmts(s.else, r, ep);
        break;
    }
    afterStmt(s, ep);
  }
}

// --- pass 2: rewrite, materializing shared subtrees ---

type Table = Map<string, string>[]; // scope stack: value key -> local name

function lookup(tables: Table, k: string): string | undefined {
  for (let i = tables.length - 1; i >= 0; i--) {
    const hit = tables[i].get(k);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function rewriteExpr(e: ScalarExpr, r: Region, ep: Epochs, tables: Table, pending: Stmt[]): ScalarExpr {
  const xs = operands(e);
  if (xs.length === 0) return e;

  const k = key(e, ep); // key over the ORIGINAL tree — matches the count pass
  const hit = lookup(tables, k);
  if (hit !== undefined) return { k: 'local', name: hit };

  const rewritten = withOperands(e, xs.map((x) => rewriteExpr(x, r, ep, tables, pending)));
  if ((r.counts.get(k) ?? 0) >= 2 && opCount(e) >= MIN_OPS) {
    const name = `#cse${r.fresh++}`;
    pending.push({ k: 'let', name, expr: rewritten });
    tables[tables.length - 1].set(k, name);
    return { k: 'local', name };
  }
  return rewritten;
}

function rewriteStmts(stmts: Stmt[], r: Region, ep: Epochs, tables: Table): Stmt[] {
  const out: Stmt[] = [];
  for (const s of stmts) {
    const pending: Stmt[] = [];
    let next: Stmt;
    switch (s.k) {
      case 'let':
      case 'assign':
      case 'setState': {
        next = { ...s, expr: rewriteExpr(s.expr, r, ep, tables, pending) };
        break;
      }
      case 'emit':
      case 'feed':
        next = { ...s, values: s.values.map((v) => rewriteExpr(v, r, ep, tables, pending)) };
        break;
      case 'if': {
        const cond = rewriteExpr(s.cond, r, ep, tables, pending);
        tables.push(new Map());
        const then = rewriteStmts(s.then, r, ep, tables);
        tables.pop();
        tables.push(new Map());
        const els = rewriteStmts(s.else, r, ep, tables);
        tables.pop();
        next = { k: 'if', cond, then, else: els };
        break;
      }
    }
    out.push(...pending, next);
    afterStmt(s, ep);
  }
  return out;
}
