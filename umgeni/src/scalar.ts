// The scalar operators, defined once: how Nile spells each, what it means
// (an evaluator), and how each backend writes it. Everything that touches
// scalar IR — elaboration, the JS and WGSL code generators, the wasm
// encoder, the host evaluator — reads this table.
//
// Classes: 'arith' (number → number), 'cmp' and 'logic' (yield a truth
// value, materialized as 1/0 where a number is needed), 'fn' (a function).

import type { BinOpName, ScalarExpr, UnOpName } from './ir.js';

type Cls = 'arith' | 'cmp' | 'logic' | 'fn';
interface OpDef<F> {
  nile: string;
  cls: Cls;
  sym: string; // C-like spelling (infix symbol, prefix symbol, or function)
  f: F;
  wasm: number; // opcode
}
const t = (b: boolean) => (b ? 1 : 0);

export const BIN: Record<BinOpName, OpDef<(a: number, b: number) => number>> = {
  add: { nile: '+', cls: 'arith', sym: '+', f: (a, b) => a + b, wasm: 0xa0 },
  sub: { nile: '-', cls: 'arith', sym: '-', f: (a, b) => a - b, wasm: 0xa1 },
  mul: { nile: '×', cls: 'arith', sym: '*', f: (a, b) => a * b, wasm: 0xa2 },
  div: { nile: '/', cls: 'arith', sym: '/', f: (a, b) => a / b, wasm: 0xa3 },
  lt: { nile: '<', cls: 'cmp', sym: '<', f: (a, b) => t(a < b), wasm: 0x63 },
  le: { nile: '≤', cls: 'cmp', sym: '<=', f: (a, b) => t(a <= b), wasm: 0x65 },
  gt: { nile: '>', cls: 'cmp', sym: '>', f: (a, b) => t(a > b), wasm: 0x64 },
  ge: { nile: '≥', cls: 'cmp', sym: '>=', f: (a, b) => t(a >= b), wasm: 0x66 },
  eq: { nile: '=', cls: 'cmp', sym: '==', f: (a, b) => t(a === b), wasm: 0x61 },
  ne: { nile: '≠', cls: 'cmp', sym: '!=', f: (a, b) => t(a !== b), wasm: 0x62 },
  and: { nile: '∧', cls: 'logic', sym: '&&', f: (a, b) => t(a !== 0 && b !== 0), wasm: 0x71 },
  or: { nile: '∨', cls: 'logic', sym: '||', f: (a, b) => t(a !== 0 || b !== 0), wasm: 0x72 },
};

export const UN: Record<UnOpName, OpDef<(a: number) => number>> = {
  neg: { nile: '-_', cls: 'arith', sym: '-', f: (a) => -a, wasm: 0x9a },
  not: { nile: '¬_', cls: 'logic', sym: '!', f: (a) => t(a === 0), wasm: 0x45 },
  sqrt: { nile: '√_', cls: 'fn', sym: 'sqrt', f: Math.sqrt, wasm: 0x9f },
  floor: { nile: '⌊_⌋', cls: 'fn', sym: 'floor', f: Math.floor, wasm: 0x9c },
  ceil: { nile: '⌈_⌉', cls: 'fn', sym: 'ceil', f: Math.ceil, wasm: 0x9b },
};

// Evaluate an expression whose leaves the caller resolves (the host side of
// GPU state folding).
export function evalScalar(e: ScalarExpr, leaf: (e: ScalarExpr) => number): number {
  switch (e.k) {
    case 'bin': return BIN[e.op].f(evalScalar(e.a, leaf), evalScalar(e.b, leaf));
    case 'un': return UN[e.op].f(evalScalar(e.a, leaf));
    case 'select': return evalScalar(e.cond, leaf) !== 0 ? evalScalar(e.then, leaf) : evalScalar(e.else, leaf);
    case 'const': return e.value;
    default: return leaf(e);
  }
}

// --- C-like text rendering (JS and WGSL differ only in spelling) ---

export interface Dialect {
  num(v: number): string;
  leaf(e: ScalarExpr): string; // param / state / input / local
  ofBool(c: string): string; // a truth value where a number is needed
  truthy(x: string): string; // a number used as a condition
  select(c: string, a: string, b: string): string;
  fn(name: string): string;
  eq: string; // spelling of '=='
  ne: string;
  // Render conditions natively (true), or always via truthy(number).
  boolCond: boolean;
}

export function renderExpr(e: ScalarExpr, d: Dialect): string {
  switch (e.k) {
    case 'const':
      return d.num(e.value);
    case 'bin': {
      const op = BIN[e.op];
      if (op.cls === 'arith') return `(${renderExpr(e.a, d)} ${op.sym} ${renderExpr(e.b, d)})`;
      return d.ofBool(native(e, d));
    }
    case 'un': {
      const op = UN[e.op];
      if (op.cls === 'arith') return `(${op.sym}${renderExpr(e.a, d)})`;
      if (op.cls === 'fn') return `${d.fn(op.sym)}(${renderExpr(e.a, d)})`;
      return d.ofBool(native(e, d));
    }
    case 'select':
      return d.select(renderCond(e.cond, d), renderExpr(e.then, d), renderExpr(e.else, d));
    default:
      return d.leaf(e);
  }
}

// An expression in a condition position (if, select).
export const renderCond = (e: ScalarExpr, d: Dialect): string =>
  d.boolCond ? native(e, d) : d.truthy(renderExpr(e, d));

// The expression as a native truth value.
function native(e: ScalarExpr, d: Dialect): string {
  if (e.k === 'bin' && BIN[e.op].cls === 'cmp') {
    const sym = e.op === 'eq' ? d.eq : e.op === 'ne' ? d.ne : BIN[e.op].sym;
    return `(${renderExpr(e.a, d)} ${sym} ${renderExpr(e.b, d)})`;
  }
  if (e.k === 'bin' && BIN[e.op].cls === 'logic') return `(${native(e.a, d)} ${BIN[e.op].sym} ${native(e.b, d)})`;
  if (e.k === 'un' && e.op === 'not') return `!${native(e.a, d)}`;
  if (e.k === 'const') return e.value !== 0 ? 'true' : 'false';
  return d.truthy(renderExpr(e, d));
}
