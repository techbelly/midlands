// The concrete domain: scalars are numbers, effects happen. Running the
// kernel semantics (nile.mooi) in this domain interprets the kernel —
// the same definition the compiler stages, so interpreter and compiled code
// must agree bit for bit.

import type * as A from '../ast.js';
import { identity, pipeline, type Op, type Token } from '../runtime.js';
import { BIN, UN } from '../scalar.js';
import { fromExprs, shapeWidth, type Shape, type Value } from '../values.js';
import type { Domain, Program } from './domain.js';
import { Semantics } from './nile.js';

export interface KernelContext {
  kernel: A.Kernel; // desugared
  params: { names: string[]; shape: Shape }[];
  sig: { input: Shape; output: Shape };
}

// `resolve` finds the processes a mid-stream ⇒ names. With it, `⇒` means
// what it meant in the original C runtime: this process *becomes* the
// pipeline, which receives the rest of the input (no defunctionalization).
export function interpretKernel(
  P: Program,
  k: A.Kernel, // desugared
  params: { names: string[]; shape: Shape }[],
  sig: { input: Shape; output: Shape },
  paramValues: number[],
  resolve?: (name: string) => KernelContext | undefined,
): Op {
  let emit = (_t: Token) => {};
  const queue: Token[] = []; // feedback: LIFO, as the runtime drains it
  const state: number[] = [];
  let became: Op | null = null; // after ⇒: the pipeline this process became
  const D: Domain<number> = {
    num: (v) => v,
    bin: (op, a, b) => BIN[op].f(a, b),
    un: (op, a) => UN[op].f(a),
    select: (c, a, b) => (c !== 0 ? a : b),
    let: (_n, v) => v,
    cell: (_n, init) => {
      let v = init;
      return { get: () => v, set: (x) => void (v = x) };
    },
    branch: (c, t, e) => (c !== 0 ? t() : e()),
    emit: (vs) => emit(vs),
    feed: (vs) => void queue.push(vs),
    state: (i) => ({ get: () => state[i], set: (v) => void (state[i] = v) }),
    forward: (stages) => {
      if (!resolve) throw new Error('mid-stream ⇒ needs a resolver');
      const ops = stages.flatMap((st) => {
        if (!st) return []; // (→)
        const c = resolve(st.name) ?? (() => { throw new Error(`⇒ to unknown '${st.name}'`); })();
        return [interpretKernel(P, c.kernel, c.params, c.sig, st.args, resolve)];
      });
      became = ops.length > 0 ? pipeline(ops) : identity();
      became.setEmit((t) => emit(t));
    },
  };
  let at = 0;
  const value: Value<number> = {
    k: 'agg',
    shape: { k: 'record', name: null, fields: [] },
    parts: params.flatMap((g) => g.names.map(() => {
      const w = shapeWidth(g.shape);
      const v = fromExprs(g.shape, paramValues.slice(at, at + w));
      at += w;
      return v;
    })),
  };
  const sem = new Semantics(P, D).kernel(k, value, params.map((g) => g.names), sig);
  state.push(...sem.initial);
  let seeded = false;
  const seed = () => {
    if (!seeded) {
      seeded = true;
      sem.init();
    }
  };
  const drain = () => {
    while (queue.length > 0) {
      if (became) {
        // Tokens still pending go to the new pipeline, in the order they
        // would have been consumed.
        for (const t of queue.splice(0).reverse()) became.push(t);
        return;
      }
      sem.step(fromExprs(sig.input, queue.pop()!));
    }
  };
  return {
    push(t) {
      seed();
      if (became) return became.push(t);
      queue.push(t);
      drain();
    },
    end() {
      seed();
      drain();
      if (!became) sem.flush(); // the flush body may ⇒ too
      if (became) became.end();
    },
    setEmit(e) {
      emit = e;
    },
  };
}
