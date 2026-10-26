// Shapes, layouts and slot readers: the TypeScript side of Nile's values.
// A Nile value under elaboration is a tree with a scalar at each leaf and a
// record (or tuple) at each node; its Shape is the tree's skeleton. The
// algebra over those trees (fitting, broadcasting, componentwise lifting,
// destructuring) is written in semantics/values.mooi. What stays here is
// what a host must build before the equations run: shapes from types,
// token layouts for the host API, and values that read consecutive slots.
// Everything here is pure.

import type { ScalarExpr, TokenLayout } from './ir.js';

// --- shapes ------------------------------------------------------------------

export type Shape = { k: 'real' } | RecordShape;
export interface RecordShape {
  k: 'record';
  name: string | null; // null: anonymous tuple
  fields: { name: string | null; shape: Shape }[];
}
export const REAL: Shape = { k: 'real' };

// A record's token layout: each named field by path, at its flattened offset.
export function tokenLayout(s: RecordShape): TokenLayout {
  const fields: TokenLayout['fields'] = {};
  const walk = (r: RecordShape, prefix: string, base: number) => {
    let at = base;
    for (const f of r.fields) {
      const width = shapeWidth(f.shape);
      if (f.name !== null) {
        fields[prefix + f.name] = { at, width };
        if (f.shape.k === 'record') walk(f.shape, `${prefix}${f.name}.`, at);
      }
      at += width;
    }
  };
  walk(s, '', 0);
  return { width: shapeWidth(s), fields };
}

export function shapeWidth(s: Shape): number {
  return s.k === 'real' ? 1 : s.fields.reduce((n, f) => n + shapeWidth(f.shape), 0);
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
// aggregate of parts.

// Generic in the scalar: an IR expression when compiling (the default), a
// number when interpreting — the algebra does not care (semantics/).
export type Value<S = ScalarExpr> =
  | { k: 'scalar'; expr: S }
  | { k: 'agg'; shape: RecordShape; parts: Value<S>[] };

export const scalar = <S = ScalarExpr>(expr: S): Value<S> => ({ k: 'scalar', expr });

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

// One value per parameter name, over consecutive slots; `part` reads a shape
// at an offset. The names are in group order, as the values are.
export function paramParts<S>(params: { names: string[]; shape: Shape }[], part: (shape: Shape, at: number) => Value<S>): { names: string[]; parts: Value<S>[]; width: number } {
  const names: string[] = [];
  const parts: Value<S>[] = [];
  let width = 0;
  for (const g of params) {
    for (const n of g.names) {
      names.push(n);
      parts.push(part(g.shape, width));
      width += shapeWidth(g.shape);
    }
  }
  return { names, parts, width };
}

// A value reading a contiguous run of slots (param/state/input).
export function fromSlots(shape: Shape, kind: 'param' | 'state' | 'input', base: number): Value {
  const exprs: ScalarExpr[] = [];
  for (let i = 0; i < shapeWidth(shape); i++) exprs.push({ k: kind, index: base + i });
  return fromExprs(shape, exprs);
}
