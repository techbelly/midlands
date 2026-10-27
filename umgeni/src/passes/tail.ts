// Tail feeds: a `<<` that is the last thing its token does.
//
// Feedback runs on a LIFO worklist, so a feed that nothing follows would be
// pushed and popped straight back: it is simply the stage's next token. This
// pass marks such feeds (`tail`), and a back end goes round its loop again
// instead of pushing and popping. A kernel whose every feed is a tail feed
// (ExpandSpans: `>> …; << …`) feeds at most once per token and needs no
// worklist at all; DecomposeBeziers feeds twice in a row, so its first feed
// is pushed and its second is the next turn.
//
// Only the per-token body is marked: a prologue's feeds run before the loop.

import { anyStmt, mapKernels, type KernelIR, type ModuleIR, type Stmt } from '../ir.js';

export const tailModule = (mod: ModuleIR): ModuleIR => mapKernels(mod, tailKernel);

const tailKernel = (k: KernelIR): KernelIR => ({ ...k, body: markTail(k.body) });

// The last statement of a block is in tail position; an `if` there puts the
// last statement of each branch in tail position too.
function markTail(stmts: Stmt[]): Stmt[] {
  const last = stmts[stmts.length - 1];
  if (!last) return stmts;
  const before = stmts.slice(0, -1);
  if (last.k === 'feed') return [...before, { ...last, tail: true }];
  if (last.k === 'if') return [...before, { ...last, then: markTail(last.then), else: markTail(last.else) }];
  return stmts;
}

// Whether a body still needs a worklist: some feed is not a tail feed.
export const needsWorklist = (stmts: Stmt[]): boolean => anyStmt(stmts, (s) => s.k === 'feed' && !s.tail);

// How a back end runs a per-token body. A body that never feeds runs
// straight through. A tail feed is the loop's next turn, so a body whose
// every feed is one (ExpandSpans) is a loop over one token, no worklist.
// Several feeds in a row (DecomposeBeziers) need the worklist, popped at the
// top of the loop unless the last turn fed.
export type StageShape = 'straight' | 'loop' | 'worklist';
export const stageShape = (body: Stmt[]): StageShape =>
  !anyStmt(body, (s) => s.k === 'feed') ? 'straight' : needsWorklist(body) ? 'worklist' : 'loop';
