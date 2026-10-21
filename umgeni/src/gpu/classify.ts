// Kernel classification for GPU backends. Phase A handles only the
// map class: one thread per token, no cross-token effects.
//
//   map: no init body, no epilogue, no feedback, no state writes, and
//        exactly one emit which is the last top-level statement (so every
//        token produces exactly one output token).
//
// Everything else (dynamic expansion, carried state, sorts) is later phases;
// classification is derived from the IR, not annotated by hand.

import { anyStmt, type KernelIR } from '../ir.js';

export function isMapKernel(k: KernelIR): boolean {
  if (k.init.length > 0 || k.epilogue.length > 0) return false;
  if (anyStmt(k.body, (s) => s.k === 'feed' || s.k === 'assign' || s.k === 'setState')) return false;
  const emits = k.body.filter((s) => s.k === 'emit');
  if (emits.length !== 1 || k.body[k.body.length - 1].k !== 'emit') return false;
  // No emit hidden in a branch: every token emits exactly once.
  if (anyStmt(k.body.slice(0, -1), (s) => s.k === 'emit')) return false;
  return true;
}
