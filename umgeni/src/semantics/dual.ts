// Dual numbers: a value together with its derivatives along n directions.
// Running Nile's meaning (nile.mooi) on these instead of on the reals gives
// every output of a kernel with how it moves as the inputs move: the
// equations are the interpreter's, unchanged.
//
// The arithmetic is written once, over whatever the values and derivatives
// themselves are (dualArithmetic): numbers, for the interpreter (duals), or
// expressions of the IR, for the pass that makes a compiled library its own
// derivative (passes/derivative.ts). So the two cannot say different rules.
//
// Only six operators have a derivative to say: + - × / negation and √. A
// comparison, a truth value, ⌊ ⌋ and ⌈ ⌉ are constant wherever they are
// differentiable at all, and a choice ({a if c, b}, `if`) follows the value,
// so what comes out is the derivative of the branch that was taken.
//
// Where a function has no derivative the answer says so: √ at 0 of
// something that moves is ±Infinity, and what is computed from that may be
// NaN, as in any forward-mode differentiation. √ of what does not move is
// still, though, even at 0, where the rule would say 0/0.
//
// In a token of w scalars the values come first and then each direction's
// w derivatives, so a key or a field is at the same offset as on the reals.
// SortBy, GroupBy and Reverse carry dual tokens as they stand. ReduceBy by +
// does when it is told to add each direction's copy of a field as well as
// the field (a sum's derivative is the sum of the derivatives). DupZip does
// not: it joins two tokens end to end, which is not this layout.

import type { BinOpName, UnOpName } from '../ir.js';
import { BIN, UN } from '../scalar.js';
import type { Scalars } from './concrete.js';

export interface Dual<S = number> {
  v: S;
  d: S[];
}

// What the values and derivatives are made of. `zero` says a scalar is
// known to be zero without running anything: never, for a number met at
// run time; a literal 0, for an expression. Where it is known the rules
// leave out what would only add or multiply by it.
export interface Base<S> {
  num(v: number): S;
  bin(op: BinOpName, a: S, b: S): S;
  un(op: UnOpName, a: S): S;
  select(c: S, a: S, b: S): S;
  zero(s: S): boolean;
}

export interface DualArithmetic<S> {
  num(v: number): Dual<S>;
  bin(op: BinOpName, a: Dual<S>, b: Dual<S>): Dual<S>;
  un(op: UnOpName, a: Dual<S>): Dual<S>;
  select(c: Dual<S>, a: Dual<S>, b: Dual<S>): Dual<S>;
}

export function dualArithmetic<S>(n: number, B: Base<S>): DualArithmetic<S> {
  const ZERO = B.num(0);
  const still = (): S[] => new Array<S>(n).fill(ZERO);
  const constant = (v: S): Dual<S> => ({ v, d: still() });
  const add = (x: S, y: S): S => (B.zero(x) ? y : B.zero(y) ? x : B.bin('add', x, y));
  const sub = (x: S, y: S): S => (B.zero(y) ? x : B.bin('sub', x, y));
  const mul = (x: S, y: S): S => (B.zero(x) || B.zero(y) ? ZERO : B.bin('mul', x, y));
  const div = (x: S, y: S): S => (B.zero(x) ? ZERO : B.bin('div', x, y));
  const each = (a: Dual<S>, b: Dual<S>, f: (da: S, db: S) => S): S[] => a.d.map((da, i) => f(da, b.d[i]));
  return {
    num: (v) => constant(B.num(v)),
    bin(op, a, b) {
      const v = B.bin(op, a.v, b.v);
      switch (op) {
        case 'add': return { v, d: each(a, b, add) };
        case 'sub': return { v, d: each(a, b, sub) };
        case 'mul': return { v, d: each(a, b, (da, db) => add(mul(da, b.v), mul(a.v, db))) };
        case 'div': return { v, d: each(a, b, (da, db) => div(sub(da, mul(v, db)), b.v)) };
        default: return constant(v);
      }
    },
    un(op, a) {
      const v = B.un(op, a.v);
      switch (op) {
        case 'neg': return { v, d: a.d.map((da) => (B.zero(da) ? ZERO : B.un('neg', da))) };
        case 'sqrt': return { v, d: a.d.map((da) => (B.zero(da) ? ZERO : B.select(B.bin('eq', da, ZERO), ZERO, B.bin('div', da, B.bin('mul', B.num(2), v))))) };
        default: return constant(v);
      }
    },
    select: (c, a, b) => ({
      v: B.select(c.v, a.v, b.v),
      d: each(a, b, (da, db) => (B.zero(da) && B.zero(db) ? ZERO : B.select(c.v, da, db))),
    }),
  };
}

// On numbers: nothing is known to be zero before it is met.
const numbers: Base<number> = {
  num: (v) => v,
  bin: (op, a, b) => BIN[op].f(a, b),
  un: (op, a) => UN[op].f(a),
  select: (c, a, b) => (c !== 0 ? a : b),
  zero: () => false,
};

// How a token holds duals: w values, then each direction's w derivatives.
export function readDuals(t: number[], n: number): Dual[] {
  const w = t.length / (1 + n);
  if (!Number.isInteger(w)) throw new Error(`a dual token in ${n} directions has ${1 + n} numbers a scalar, not ${t.length} in all`);
  return Array.from({ length: w }, (_, i) => ({ v: t[i], d: Array.from({ length: n }, (_, j) => t[(j + 1) * w + i]) }));
}
export function writeDuals(xs: Dual[], n: number): number[] {
  const w = xs.length;
  const t = new Array<number>(w * (1 + n));
  xs.forEach((x, i) => {
    t[i] = x.v;
    x.d.forEach((dx, j) => (t[(j + 1) * w + i] = dx));
  });
  return t;
}

// The interpreter's kind of number (concrete.ts).
export function duals(n: number): Scalars<Dual> {
  const A = dualArithmetic(n, numbers);
  return {
    num: A.num,
    bin: A.bin,
    un: A.un,
    truth: (c) => c.v !== 0,
    read: (t) => readDuals(t, n),
    write: (xs) => writeDuals(xs, n),
  };
}

// A token with its derivatives, as a host makes one: the values, then for
// each direction how far each value moves along it.
export const dualToken = (values: number[], n: number, moves: (direction: number) => number[]): number[] =>
  [...values, ...Array.from({ length: n }, (_, d) => moves(d)).flat()];
