// A tiny evaluator for scalar IR expressions on the host. Used to fold a
// kernel's (read-only) state initializers into the parameter vector before
// upload: state slots never change in a map kernel, so the GPU sees them as
// extra params rather than re-deriving them per thread.

import type { ScalarExpr } from '../ir.js';
import { evalScalar } from '../scalar.js';

export function evalScalarAt(e: ScalarExpr, params: readonly number[], state: readonly number[]): number {
  return evalScalar(e, (leaf) => {
    if (leaf.k === 'param') return params[leaf.index];
    if (leaf.k === 'state') return state[leaf.index];
    throw new Error(`${leaf.k} has no value at initialization time`);
  });
}

// Evaluate a kernel's state initializers (each may reference earlier slots).
export function evalStateInit(stateInit: ScalarExpr[], params: readonly number[]): number[] {
  const state: number[] = [];
  for (const e of stateInit) state.push(evalScalarAt(e, params, state));
  return state;
}
