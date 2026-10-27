// Scalar IR as text in a C-like language. JavaScript and WGSL differ only
// in spelling, which a Dialect supplies: the code generators (cpu/js.ts,
// gpu/wgsl.ts) render expressions and conditions through this file.

import type { ScalarExpr } from './ir.js';
import { BIN, UN } from './scalar.js';

// A name as Nile wrote it, made legal in a C-like language: the prime of a
// primed state local and the # of a compiler temporary become underscores.
// Each back end adds its own prefix, since no Nile name starts with one.
export const sanitize = (name: string): string => name.replace(/'/g, '_p').replace(/#/g, '_');

export type Leaf = Extract<ScalarExpr, { k: 'param' | 'state' | 'input' | 'local' }>;

export interface Dialect {
  num(v: number): string;
  leaf(e: Leaf): string;
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
