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

import { mapKernels, opCount, operands, withOperands, type KernelIR, type ModuleIR, type ScalarExpr, type Stmt } from '../ir.js';

export const cseModule = (mod: ModuleIR): ModuleIR => mapKernels(mod, cseKernel);

function cseKernel(p: KernelIR): KernelIR {
  return {
    ...p,
    init: cseRegion(p.init),
    body: cseRegion(p.body),
    epilogue: cseRegion(p.epilogue),
  };
}

// Materialize a shared subtree only if it is at least this many ops — a
// single shared add is not worth a let.
const MIN_OPS = 2;

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
  const region: Region = { counts: new Map(), fresh: 0 };
  countStmts(stmts, region, newEpochs());
  return rewriteStmts(stmts, region, newEpochs(), [new Map()]);
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
