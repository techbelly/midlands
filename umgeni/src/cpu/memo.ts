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
// `reads[i]` is the parameter slots part i reads. A run in flight is a
// Run: the ops built from some part on, the array it will be remembered
// under (null once it cannot be: fed token by token, or a second batch),
// and the outputs kept so far, by part and at parts.length the whole.
// `from` is the part the ops start at: a run from kept work can take no
// second batch, since the parts before it were not built.
interface Run {
  ops: Op[];
  from: number;
  input: Token[] | null;
  outputs: (Token[] | undefined)[];
}
const streamed = (): Run => ({ ops: [], from: 0, input: null, outputs: [] });

export function memoPipeline(cache: Memo, P: number[], parts: (() => Op)[], barrier: boolean[], reads: number[][]): Op {
  const END = parts.length;
  let emit: Emit = () => {};
  let run: Run | null = null;

  const feedAll = (op: Op, ts: Token[]) => {
    if (op.pushAll) op.pushAll(ts);
    else for (const t of ts) op.push(t);
  };

  // The ops of parts [start, END), wired: a barrier's whole output, and the
  // whole output, are kept on their way out while the run is remembered.
  const wire = (start: number, r: Run): Run => {
    for (let i = start; i < END; i++) r.ops.push(parts[i]());
    r.ops.forEach((op, j) => {
      const i = start + j;
      const next = r.ops[j + 1];
      if (barrier[i] && op.setEmitAll) {
        op.setEmitAll((ts) => {
          if (r.input) {
            r.outputs[i] = ts;
            if (!next) r.outputs[END] = ts;
          }
          if (next) feedAll(next, ts);
          else for (const t of ts) emit(t);
        });
      } else if (next) op.setEmit((t) => next.push(t));
      else op.setEmit((t) => {
        if (r.input) r.outputs[END]!.push(t);
        emit(t);
      });
    });
    return r;
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

  // A run over a whole array: from what an earlier run over it left, as
  // far as that is still good, else from the start.
  const startRun = (ts: Token[]): Run => {
    const e = cache.get(ts);
    const c = e ? reusable(e) : -1;
    const r: Run = { ops: [], from: c + 1, input: ts, outputs: e ? e.outputs.slice(0, c + 1) : [] };
    if (c === END) { // the whole output replayed: nothing to run, end() only remembers
      for (const t of e!.outputs[END]!) emit(t);
      return r;
    }
    r.outputs[END] = [];
    wire(c + 1, r);
    feedAll(r.ops[0], c >= 0 ? e!.outputs[c]! : ts);
    return r;
  };

  return {
    push(t) {
      if (END === 0) return emit(t);
      run ??= wire(0, streamed());
      run.ops[0].push(t);
    },
    pushAll(ts) {
      if (END === 0) return ts.forEach((t) => emit(t));
      if (run) { // a second batch: this run is not remembered
        if (run.from > 0) throw new Error('a run from kept work takes one batch of tokens');
        run.input = null;
        return feedAll(run.ops[0], ts);
      }
      run = startRun(ts);
    },
    end() {
      run ??= wire(0, streamed());
      for (const op of run.ops) op.end();
      if (run.input) cache.set(run.input, { P: P.slice(), outputs: run.outputs });
    },
    whole: () => (run !== null && run.input !== null && run.outputs[END]) || null,
    setEmit(e) {
      emit = e;
    },
  };
}
