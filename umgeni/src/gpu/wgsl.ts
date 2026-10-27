// Scalar IR rendered as WGSL statements. gpu/lower.ts and gpu/texture.ts
// each supply a WgslEnv saying how a parameter, state slot, input slot, emit
// or feed is spelled in their shader; this file knows only the statements.
//
// The scalar IR ports almost directly: pure f32 arithmetic, structured
// control flow, single-assignment locals. The one representational shift is
// that WGSL comparisons yield bool, so a numeric context materializes
// 0.0/1.0 through select while a boolean context stays native (mirroring
// the JS back end's boolCond option).
//
// PRECISION: WGSL computes in f32; the reference backend in f64. GPU output
// is compared with tolerances, not bit-equality.

import { allStmts, type ScalarExpr, type Stmt } from '../ir.js';
import { renderCond, renderExpr, type Dialect, sanitize } from '../scalar.js';

function fmt(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return v < 0 ? `(-${Math.abs(v)}.0)` : `${v}.0`;
  const s = String(v);
  return v < 0 ? `(${s})` : s;
}

// A local as WGSL spells it: sanitize's form (scalar.ts) behind 'v', not
// '_', since WGSL reserves identifiers starting with '__', which '#cse0'
// would otherwise become. (The corpus is ASCII; Unicode identifiers are
// legal in modern WGSL but not relied on yet.)
export const mangle = (name: string): string => 'v' + sanitize(name);

// How slot references and emit/feed render inside a shader — the WGSL
// mirror of the JS codegen's GenEnv. Scaffolds (texture paint functions,
// the lowering's stage functions) plug kernel bodies into their own plumbing
// through these two. What an expression needs: the spelling of each kind
// of leaf.
export interface WgslExprEnv {
  param(i: number): string;
  state(i: number): string;
  input(i: number): string;
  /** Local-name rendering override (e.g. a per-stage prefix when several
   *  kernel bodies share one shader function). Defaults to the module
   *  mangler. */
  local?(name: string): string;
}
// What statements need besides: where emits and feeds go.
export interface WgslEnv extends WgslExprEnv {
  emit(vals: string[], indent: string): string;
  feed(vals: string[], indent: string, tail: boolean): string; // tail: passes/tail.ts
}
const localName = (c: WgslExprEnv, n: string) => (c.local ? c.local(n) : mangle(n));

// WGSL is the C-like rendering of scalar.ts with WGSL spellings.
const dialect = (c: WgslExprEnv): Dialect => ({
  num: fmt,
  leaf: (e) =>
    e.k === 'param' ? c.param(e.index)
    : e.k === 'state' ? c.state(e.index)
    : e.k === 'input' ? c.input(e.index)
    : localName(c, e.name),
  ofBool: (b) => `select(0.0, 1.0, ${b})`,
  truthy: (x) => `(${x} != 0.0)`,
  select: (b, x, y) => `select(${y}, ${x}, ${b})`,
  fn: (f) => f,
  eq: '==',
  ne: '!=',
  boolCond: true,
});
// A single expression, for scaffolds that bind values themselves.
export const wgslExpr = (e: ScalarExpr, c: WgslExprEnv): string => renderExpr(e, dialect(c));
const cond = (e: ScalarExpr, c: WgslExprEnv) => renderCond(e, dialect(c));

// An environment for an expression over parameters alone (a stage argument,
// a state initializer): anything else is the caller's error to name.
export const paramsOnly = (param: (i: number) => string, fail: (what: string) => never): WgslExprEnv =>
  ({ param, state: () => fail('state'), input: () => fail('input') });

// Generate a kernel body as WGSL statements against an environment. This is
// the exported seam: scaffolds wrap it in their own dispatch/worklist code.
export function wgslBody(list: Stmt[], indent: string, c: WgslEnv, mutable = assignedNames(list)): string {
  const lines: string[] = [];
  const name = (n: string) => localName(c, n);
  for (const s of list) {
    switch (s.k) {
      case 'let':
        // Primed state locals are reassigned, so they are WGSL vars.
        lines.push(`${indent}${mutable.has(s.name) ? 'var' : 'let'} ${name(s.name)} = ${wgslExpr(s.expr, c)};`);
        break;
      case 'assign':
        lines.push(`${indent}${name(s.name)} = ${wgslExpr(s.expr, c)};`);
        break;
      case 'emit':
        lines.push(c.emit(s.values.map((v) => wgslExpr(v, c)), indent));
        break;
      case 'feed':
        lines.push(c.feed(s.values.map((v) => wgslExpr(v, c)), indent, s.tail === true));
        break;
      case 'setState':
        // Valid only where the env's state is mutable (thread-local arrays);
        // map kernels never contain setState by classification.
        lines.push(`${indent}${c.state(s.index)} = ${wgslExpr(s.expr, c)};`);
        break;
      case 'if':
        lines.push(`${indent}if (${cond(s.cond, c)}) {`);
        lines.push(wgslBody(s.then, indent + '  ', c, mutable));
        if (s.else.length > 0) {
          lines.push(`${indent}} else {`);
          lines.push(wgslBody(s.else, indent + '  ', c, mutable));
        }
        lines.push(`${indent}}`);
        break;
      default:
        throw new Error(`statement '${(s as Stmt).k}' has no WGSL lowering`);
    }
  }
  return lines.filter((l) => l !== '').join('\n');
}

const assignedNames = (list: Stmt[]) =>
  new Set([...allStmts(list)].flatMap((s) => (s.k === 'assign' ? [s.name] : [])));

export const WORKGROUP_SIZE = 64;
