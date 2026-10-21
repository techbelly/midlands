// The value algebra of elaboration. A Nile value under elaboration is a
// tree: a scalar expression at each leaf, a record (or tuple) of values at
// each node — its Shape is the tree's skeleton. Operators are defined on
// scalars and *lifted*: a scalar broadcasts against a record, records of
// one shape zip, so `A + B` on Colors, `⌊ P ⌋` on Points and a guard with a
// Point condition are all the same rule (rank polymorphism, as in APL).
// Everything here is pure.

import type * as A from './ast.js';
import type { ScalarExpr } from './ir.js';

// --- shapes ------------------------------------------------------------------

export type Shape = { k: 'real' } | RecordShape;
export interface RecordShape {
  k: 'record';
  name: string | null; // null: anonymous tuple
  fields: { name: string | null; shape: Shape }[];
}
export const REAL: Shape = { k: 'real' };

export function shapeWidth(s: Shape): number {
  return s.k === 'real' ? 1 : s.fields.reduce((n, f) => n + shapeWidth(f.shape), 0);
}

function structEq(a: Shape, b: Shape): boolean {
  if (a.k === 'real' || b.k === 'real') return a.k === b.k;
  return a.fields.length === b.fields.length
    && a.fields.every((f, i) => structEq(f.shape, b.fields[i].shape));
}

// Leaf offset and shape of a named field (for SortBy keys and field access).
export function fieldInfo(shape: Shape, name: string): { index: number; offset: number; shape: Shape } {
  if (shape.k === 'real') throw new ElabError(`a Real has no field '.${name}'`);
  let offset = 0;
  for (let i = 0; i < shape.fields.length; i++) {
    const f = shape.fields[i];
    if (f.name === name) return { index: i, offset, shape: f.shape };
    offset += shapeWidth(f.shape);
  }
  throw new ElabError(`type '${shape.name ?? '(tuple)'}' has no field '.${name}'`);
}

export class ElabError extends Error {}

// --- values ------------------------------------------------------------------
// A value under elaboration mirrors its shape: a scalar expression, or an
// aggregate of parts. This is chari's CV, building expression trees instead of
// closures.

// Generic in the scalar: an IR expression when compiling (the default), a
// number when interpreting — the algebra does not care (semantics/).
export type Value<S = ScalarExpr> =
  | { k: 'scalar'; expr: S }
  | { k: 'agg'; shape: RecordShape; parts: Value<S>[] };

export const scalar = <S = ScalarExpr>(expr: S): Value<S> => ({ k: 'scalar', expr });

export function shapeOf<S>(v: Value<S>): Shape {
  return v.k === 'scalar' ? REAL : v.shape;
}

export function flatten<S>(v: Value<S>): S[] {
  return v.k === 'scalar' ? [v.expr] : v.parts.flatMap(flatten);
}

export function fromExprs<S>(shape: Shape, exprs: S[], base = 0): Value<S> {
  if (shape.k === 'real') return scalar(exprs[base]);
  const parts: Value<S>[] = [];
  let at = base;
  for (const f of shape.fields) {
    parts.push(fromExprs(f.shape, exprs, at));
    at += shapeWidth(f.shape);
  }
  return { k: 'agg', shape, parts };
}

// A value reading a contiguous run of slots (param/state/input).
export function fromSlots(shape: Shape, kind: 'param' | 'state' | 'input', base: number): Value {
  const exprs: ScalarExpr[] = [];
  for (let i = 0; i < shapeWidth(shape); i++) exprs.push({ k: kind, index: base + i });
  return fromExprs(shape, exprs);
}

// Broadcast a scalar to fill a shape.
export function broadcast<S>(v: Value<S>, shape: Shape): Value<S> {
  if (shape.k === 'real') return v;
  return { k: 'agg', shape, parts: shape.fields.map((f) => broadcast(v, f.shape)) };
}

// Project field i; a scalar projects to itself (it is being broadcast).
export function project<S>(v: Value<S>, i: number): Value<S> {
  return v.k === 'agg' ? v.parts[i] : v;
}

// Fit a value into a target shape: exact, broadcast a scalar into a record,
// or coerce field by field — so `(s, 0)` fits `(Real, Color)`, the 0
// broadcasting into the Color. Returns null if it doesn't fit.
export function fit<S>(v: Value<S>, shape: Shape): Value<S> | null {
  if (v.k === 'scalar') return shape.k === 'real' ? v : broadcast(v, shape);
  if (shape.k === 'real' || v.parts.length !== shape.fields.length) return null;
  const parts = v.parts.map((p, i) => fit(p, shape.fields[i].shape));
  if (parts.some((p) => p === null)) return null;
  return { k: 'agg', shape, parts: parts as Value<S>[] };
}

// Apply an operation with declared parameter shapes, fitting arguments
// (broadcast/coerce) and lifting componentwise over a common record shape
// when an argument is bigger than its slot. Ported from chari's applyCV.
export function applyLifted<S>(
  paramShapes: Shape[],
  args: Value<S>[],
  applyBase: (args: Value<S>[]) => Value<S>,
): Value<S> {
  const fitted = args.map((a, i) => fit(a, paramShapes[i]));
  if (fitted.every((f) => f !== null)) return applyBase(fitted as Value<S>[]);

  // Componentwise lift: every non-fitting argument must share one shape.
  let lift: Shape | null = null;
  args.forEach((a, i) => {
    if (fitted[i] !== null) return;
    const s = shapeOf(a);
    if (s.k === 'real') throw new ElabError('operator argument does not fit its parameter');
    if (lift && !structEq(lift, s)) {
      throw new ElabError('cannot lift an operator across different record shapes');
    }
    lift = lift ?? s;
  });
  const liftShape = lift as RecordShape | null;
  if (!liftShape) throw new ElabError('internal: lift requested with no record operand');
  return {
    k: 'agg',
    shape: liftShape,
    parts: liftShape.fields.map((_, i) =>
      applyLifted(
        paramShapes,
        args.map((a, ai) => (fitted[ai] !== null ? a : project(a, i))),
        applyBase,
      )),
  };
}

// Take a value apart by a (possibly nested) tuple pattern.
export function destructure<S>(p: A.Pattern, v: Value<S>, out: [string, Value<S>][] = []): [string, Value<S>][] {
  if (p.kind === 'varPat') out.push([p.name, v]);
  else if (p.kind === 'tuplePat') {
    if (v.k !== 'agg') throw new ElabError('cannot destructure a Real');
    if (p.elements.length !== v.parts.length) {
      throw new ElabError(`pattern binds ${p.elements.length} components but the value has ${v.parts.length}`);
    }
    p.elements.forEach((el, i) => destructure(el, v.parts[i], out));
  }
  return out;
}

export function patternNames(p: A.Pattern): string[] {
  return p.kind === 'varPat' ? [p.name] : p.kind === 'tuplePat' ? p.elements.flatMap(patternNames) : [];
}

