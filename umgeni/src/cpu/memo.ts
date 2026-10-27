// Work kept between runs.
//
// A fused pipeline's output is a function of its input array and its
// parameters and nothing else: a kernel sees its token, its declared state
// and the parameter slots its arguments name (ir.ts paramReads). So a run
// over the same array may keep what an earlier run left at each barrier (a
// sort, group or reverse holds the whole stream already) and at the end,
// as far as the parts before that point read no parameter that changed.
// The memo is keyed by the array's identity (a WeakMap: an entry dies with
// its array), and a remembered run's output is the kept array itself, the
// same object run after run, so a process fed another's output finds its
// own memo too. A host must therefore not change an array, or its tokens,
// after a run. A pipeline fed token by token builds its whole chain as
// before and keeps nothing.

import type { Emit, Op, Token } from './op.js';

export interface MemoEntry {
  P: number[];
  outputs: (Token[] | undefined)[]; // by part, and at parts.length the whole output
}
export type Memo = WeakMap<Token[], MemoEntry>;
export const memo = (): Memo => new WeakMap();

// `parts` makes the pipeline's runs in order, on demand; `barrier[i]` says
// part i holds the whole stream and hands it on at end (setEmitAll);
// `reads[i]` is the parameter slots part i reads.
export function memoPipeline(cache: Memo, P: number[], parts: (() => Op)[], barrier: boolean[], reads: number[][]): Op {
  const END = parts.length;
  let emit: Emit = () => {};
  let ops: Op[] | null = null; // the chain being run
  let input: Token[] | null = null; // the array this run is remembered under
  let outputs: (Token[] | undefined)[] = [];

  const feedAll = (op: Op, ts: Token[]) => {
    if (op.pushAll) op.pushAll(ts);
    else for (const t of ts) op.push(t);
  };
  // Build and wire parts [start, END). A barrier's output, and the whole
  // output, are kept on their way out when this run is remembered.
  const build = (start: number) => {
    ops = [];
    for (let i = start; i < END; i++) ops.push(parts[i]());
    ops.forEach((op, j) => {
      const i = start + j;
      const next = ops![j + 1];
      if (barrier[i] && op.setEmitAll) {
        op.setEmitAll((ts) => {
          if (input) {
            outputs[i] = ts;
            if (!next) outputs[END] = ts;
          }
          if (next) feedAll(next, ts);
          else for (const t of ts) emit(t);
        });
      } else if (next) op.setEmit((t) => next.push(t));
      else op.setEmit((t) => {
        if (input) outputs[END]!.push(t);
        emit(t);
      });
    });
  };
  // The furthest kept output still good for these parameters: no part up
  // to it reads a slot that changed.
  const reusable = (e: MemoEntry): number => {
    let best = -1;
    for (let i = 0; i < END; i++) {
      if (!reads[i].every((k) => P[k] === e.P[k])) return best;
      if (barrier[i] && e.outputs[i]) best = i;
    }
    return e.outputs[END] ? END : best;
  };

  return {
    push(t) {
      if (END === 0) return emit(t);
      if (!ops) {
        input = null;
        build(0);
      }
      ops![0].push(t);
    },
    pushAll(ts) {
      if (END === 0) return ts.forEach((t) => emit(t));
      if (ops) { // a second batch: this run is not remembered
        input = null;
        return feedAll(ops[0], ts);
      }
      const e = cache.get(ts);
      const c = e ? reusable(e) : -1;
      input = ts;
      outputs = e ? e.outputs.slice(0, c + 1) : [];
      if (c === END) {
        ops = [];
        for (const t of e!.outputs[END]!) emit(t);
        return;
      }
      outputs[END] = [];
      build(c + 1);
      feedAll(ops![0], c >= 0 ? e!.outputs[c]! : ts);
    },
    end() {
      if (!ops) build(0);
      for (const op of ops!) op.end();
      if (input) cache.set(input, { P: P.slice(), outputs });
    },
    whole: () => (input && outputs[END]) || null,
    setEmit(e) {
      emit = e;
    },
  };
}

