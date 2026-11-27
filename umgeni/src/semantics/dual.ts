// Dual numbers: a value together with its derivatives along n directions.
// Running Nile's meaning (nile.mooi) on these instead of on the reals gives
// every output of a kernel with how it moves as the inputs move: the
// equations are the interpreter's, unchanged.
//
// Only six operators have a derivative to say: + - × / negation and √. A
// comparison, a truth value, ⌊ ⌋ and ⌈ ⌉ are constant wherever they are
// differentiable at all, and a choice ({a if c, b}, `if`) follows the value,
// so what comes out is the derivative of the branch that was taken.
//
// Where a function has no derivative the answer says so: √ at 0 of
// something that moves is ±Infinity, and what is computed from that may be
// NaN, as in any forward-mode differentiation.
//
// In a token of w scalars the values come first and then each direction's
// w derivatives, so a key or a field is at the same offset as on the reals.
// SortBy, GroupBy and Reverse carry dual tokens as they stand. ReduceBy by +
// does when it is told to add each direction's copy of a field as well as
// the field (a sum's derivative is the sum of the derivatives). DupZip does
// not: it joins two tokens end to end, which is not this layout.

import { BIN, UN } from '../scalar.js';
import type { Scalars } from './concrete.js';

export interface Dual {
  v: number;
  d: number[];
}

export function duals(n: number): Scalars<Dual> {
  const constant = (v: number): Dual => ({ v, d: new Array<number>(n).fill(0) });
  // Each direction's derivative from the operands' (da, db). Where neither
  // operand moves the result does not, whatever the values are: a constant
  // stays one through 0/0 and √0.
  const moved = (a: Dual, b: Dual, v: number, f: (da: number, db: number) => number): Dual => ({
    v,
    d: a.d.map((da, i) => (da === 0 && b.d[i] === 0 ? 0 : f(da, b.d[i]))),
  });
  return {
    num: constant,
    bin(op, a, b) {
      const v = BIN[op].f(a.v, b.v);
      switch (op) {
        case 'add': return moved(a, b, v, (da, db) => da + db);
        case 'sub': return moved(a, b, v, (da, db) => da - db);
        case 'mul': return moved(a, b, v, (da, db) => da * b.v + a.v * db);
        case 'div': return moved(a, b, v, (da, db) => (da - v * db) / b.v);
        default: return constant(v);
      }
    },
    un(op, a) {
      const v = UN[op].f(a.v);
      switch (op) {
        case 'neg': return { v, d: a.d.map((da) => -da) };
        case 'sqrt': return moved(a, a, v, (da) => da / (2 * v));
        default: return constant(v);
      }
    },
    truth: (c) => c.v !== 0,
    read(t) {
      const w = t.length / (1 + n);
      if (!Number.isInteger(w)) throw new Error(`a dual token in ${n} directions has ${1 + n} numbers a scalar, not ${t.length} in all`);
      return Array.from({ length: w }, (_, i) => ({ v: t[i], d: Array.from({ length: n }, (_, j) => t[(j + 1) * w + i]) }));
    },
    write(xs) {
      const w = xs.length;
      const t = new Array<number>(w * (1 + n));
      xs.forEach((x, i) => {
        t[i] = x.v;
        x.d.forEach((dx, j) => (t[(j + 1) * w + i] = dx));
      });
      return t;
    },
  };
}
