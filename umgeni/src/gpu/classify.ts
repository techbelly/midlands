// Kernel classification for the GPU back end. gpu/texture.ts lowers map
// kernels, one thread per token with no cross-token effects, into a texture
// shader; everything else goes through gpu/lower.ts.
//
//   map: no prologue, no flush, no feedback, no state writes, and
//        exactly one emit which is the last top-level statement (so every
//        token produces exactly one output token).
//
// Classification is derived from the IR, not annotated by hand.

import { anyStmt, type KernelIR } from '../ir.js';

export function isMapKernel(k: KernelIR): boolean {
  if (k.prologue.length > 0 || k.flush.length > 0) return false;
  if (anyStmt(k.body, (s) => s.k === 'feed' || s.k === 'assign' || s.k === 'setState')) return false;
  // The last statement emits, and nothing before it does (not in a branch
  // either): every token emits exactly once.
  if (k.body[k.body.length - 1]?.k !== 'emit') return false;
  return !anyStmt(k.body.slice(0, -1), (s) => s.k === 'emit');
}
