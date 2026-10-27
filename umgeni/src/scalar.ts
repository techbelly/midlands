// The scalar operators, defined once: how Nile spells each, what it means
// (an evaluator), how a C-like language spells it (clike.ts) and its wasm
// opcode. Elaboration, constant folding, the interpreter, the code
// generators and the wasm encoder all read this table.
//
// Classes: 'arith' (number → number), 'cmp' and 'logic' (yield a truth
// value, materialized as 1/0 where a number is needed), 'fn' (a function).

import type { BinOpName, UnOpName } from './ir.js';

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
