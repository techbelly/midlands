// The primitives of Nile's meaning. The semantics (nile.mooi) is written
// against a Domain; run it in the symbolic domain (staged.ts) and its residue
// is the compiler's IR, run it in the number domain (concrete.ts) and it is
// an interpreter.

import type * as A from '../ast.js';
import type { BinOpName, UnOpName } from '../ir.js';
import type { Shape } from '../values.js';

export interface Cell<S> {
  get(): S;
  set(v: S): void;
}

// Everything a domain must say.
export interface Domain<S> {
  num(v: number): S;
  bin(op: BinOpName, a: S, b: S): S;
  un(op: UnOpName, a: S): S;
  select(c: S, a: S, b: S): S;
  let(name: string, v: S): S; // a value computed once, here (sharing)
  cell(name: string, init: S): Cell<S>; // a mutable variable (primed state)
  branch(c: S, then: () => void, els: () => void): void;
  emit(vs: S[]): void;
  feed(vs: S[]): void;
  state(i: number): Cell<S>; // the kernel's persistent state slots
  // `⇒ S1 → … → Sn` mid-stream: the process becomes that pipeline (null: `(→)`).
  forward(stages: ({ name: string; args: S[] } | null)[]): void;
}

// What the program declares (types, user operators, process parameters).
export interface Program {
  type(t: A.Type): Shape;
  op(key: string): { params: { name: string; shape: Shape }[]; result: Shape; body: A.Expr } | undefined;
  params(process: string): Shape[] | undefined;
}
