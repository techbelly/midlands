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

import type { KernelIR, ModuleIR, ProcessIR, ScalarExpr, Stmt } from '../ir.js';

// Number of operation nodes (bin/un/select) in a tree. Shared with the
// instrumentation in codegen.
export function opCount(e: ScalarExpr): number {
  switch (e.k) {
    case 'bin':
      return 1 + opCount(e.a) + opCount(e.b);
    case 'un':
      return 1 + opCount(e.a);
    case 'select':
      return 1 + opCount(e.cond) + opCount(e.then) + opCount(e.else);
    default:
      return 0;
  }
}

export function cseModule(mod: ModuleIR): ModuleIR {
  return { ...mod, processes: mod.processes.map(cseProcess) };
}

function cseProcess(p: ProcessIR): ProcessIR {
  if (p.k === 'kernel') return cseKernel(p);
  if (p.k === 'fused') {
    return {
      ...p,
      segments: p.segments.map((seg) =>
        seg.k === 'kernels'
          ? { ...seg, stages: seg.stages.map((st) => ({ ...st, kernel: cseKernel(st.kernel) })) }
          : seg),
    };
  }
  return p;
}

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

interface Region {
  epochs: Map<string, number>; // mutable local name -> version
  stateEpoch: number;
  counts: Map<string, number>;
  fresh: number;
}

function cseRegion(stmts: Stmt[]): Stmt[] {
  const region: Region = { epochs: new Map(), stateEpoch: 0, counts: new Map(), fresh: 0 };
  countStmts(stmts, region);
  // Reset epochs for the rewrite replay (keys must match the count pass).
  region.epochs = new Map();
  region.stateEpoch = 0;
  return rewriteStmts(stmts, region, [new Map()]);
}

// --- value keys (canonical, epoch-aware) ---

function key(e: ScalarExpr, r: Region): string {
  switch (e.k) {
    case 'const':
      return `c${e.value}`;
    case 'param':
      return `p${e.index}`;
    case 'input':
      return `i${e.index}`;
    case 'state':
      return `s${e.index}@${r.stateEpoch}`;
    case 'local':
      return `l${e.name}@${r.epochs.get(e.name) ?? 0}`;
    case 'bin':
      return `(${key(e.a, r)}${e.op}${key(e.b, r)})`;
    case 'un':
      return `${e.op}(${key(e.a, r)})`;
    case 'select':
      return `?(${key(e.cond, r)};${key(e.then, r)};${key(e.else, r)})`;
  }
}

function bumpAssign(name: string, r: Region): void {
  r.epochs.set(name, (r.epochs.get(name) ?? 0) + 1);
}

// --- pass 1: occurrence counts ---

function countExpr(e: ScalarExpr, r: Region): void {
  if (e.k === 'bin') {
    countExpr(e.a, r);
    countExpr(e.b, r);
  } else if (e.k === 'un') {
    countExpr(e.a, r);
  } else if (e.k === 'select') {
    countExpr(e.cond, r);
    countExpr(e.then, r);
    countExpr(e.else, r);
  } else {
    return;
  }
  const k = key(e, r);
  r.counts.set(k, (r.counts.get(k) ?? 0) + 1);
}

function countStmts(stmts: Stmt[], r: Region): void {
  for (const s of stmts) {
    switch (s.k) {
      case 'let':
      case 'assign':
        countExpr(s.expr, r);
        if (s.k === 'assign') bumpAssign(s.name, r);
        break;
      case 'setState':
        countExpr(s.expr, r);
        r.stateEpoch++;
        break;
      case 'emit':
      case 'feed':
        for (const v of s.values) countExpr(v, r);
        break;
      case 'if':
        countExpr(s.cond, r);
        countStmts(s.then, r);
        countStmts(s.else, r);
        break;
    }
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

function rewriteExpr(e: ScalarExpr, r: Region, tables: Table, pending: Stmt[]): ScalarExpr {
  if (e.k !== 'bin' && e.k !== 'un' && e.k !== 'select') return e;

  const k = key(e, r); // key over the ORIGINAL tree — matches the count pass
  const hit = lookup(tables, k);
  if (hit !== undefined) return { k: 'local', name: hit };

  const rewritten: ScalarExpr =
    e.k === 'bin'
      ? { ...e, a: rewriteExpr(e.a, r, tables, pending), b: rewriteExpr(e.b, r, tables, pending) }
      : e.k === 'un'
        ? { ...e, a: rewriteExpr(e.a, r, tables, pending) }
        : {
            ...e,
            cond: rewriteExpr(e.cond, r, tables, pending),
            then: rewriteExpr(e.then, r, tables, pending),
            else: rewriteExpr(e.else, r, tables, pending),
          };

  if ((r.counts.get(k) ?? 0) >= 2 && opCount(e) >= MIN_OPS) {
    const name = `#cse${r.fresh++}`;
    pending.push({ k: 'let', name, expr: rewritten });
    tables[tables.length - 1].set(k, name);
    return { k: 'local', name };
  }
  return rewritten;
}

function rewriteStmts(stmts: Stmt[], r: Region, tables: Table): Stmt[] {
  const out: Stmt[] = [];
  for (const s of stmts) {
    const pending: Stmt[] = [];
    let next: Stmt;
    switch (s.k) {
      case 'let':
      case 'assign':
      case 'setState': {
        next = { ...s, expr: rewriteExpr(s.expr, r, tables, pending) };
        break;
      }
      case 'emit':
      case 'feed':
        next = { ...s, values: s.values.map((v) => rewriteExpr(v, r, tables, pending)) };
        break;
      case 'if': {
        const cond = rewriteExpr(s.cond, r, tables, pending);
        tables.push(new Map());
        const then = rewriteStmts(s.then, r, tables);
        tables.pop();
        tables.push(new Map());
        const els = rewriteStmts(s.else, r, tables);
        tables.pop();
        next = { k: 'if', cond, then, else: els };
        break;
      }
    }
    out.push(...pending, next);
    // Replay mutations exactly as the count pass saw them.
    if (s.k === 'assign') bumpAssign(s.name, r);
    if (s.k === 'setState') r.stateEpoch++;
  }
  return out;
}
