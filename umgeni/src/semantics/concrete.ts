// The concrete domain: scalars are numbers, effects happen. Running the
// kernel semantics (nile.mooi) in this domain interprets the kernel —
// the same definition the compiler stages, so interpreter and compiled code
// must agree bit for bit.
//
// "Numbers" is any kind of scalar that can say what arithmetic means, when
// it counts as true, and how it lies in a token (Scalars). On the reals that
// is the interpreter; on dual numbers (dual.ts) the same equations give
// each output with its derivatives.

import { identity, pipeline, type Op, type Token } from '../cpu/runtime.js';
import type { BinOpName, UnOpName } from '../ir.js';
import { BIN, UN } from '../scalar.js';
import { fromExprs, paramEnv } from '../values.js';
import type { Domain, KernelContext, Program } from './domain.js';
import { Semantics } from './nile.js';

// A kind of number. `read` and `write` say how a token of the runtime (flat
// numbers) holds this kind's scalars, so a kernel on this kind composes with
// the runtime's stages; which of those stages carry such a token rightly is
// the kind's to say (dual.ts does).
export interface Scalars<S> {
  num(v: number): S;
  bin(op: BinOpName, a: S, b: S): S;
  un(op: UnOpName, a: S): S;
  truth(c: S): boolean;
  read(t: Token): S[];
  write(xs: S[]): Token;
}

export const reals: Scalars<number> = {
  num: (v) => v,
  bin: (op, a, b) => BIN[op].f(a, b),
  un: (op, a) => UN[op].f(a),
  truth: (c) => c !== 0,
  read: (t) => t,
  write: (xs) => xs,
};

// The domain on a kind of number. The effects that leave a kernel (emit,
// feed, forward) go where `to` says; state is the kernel's slots.
type Effects<S> = Pick<Domain<S>, 'emit' | 'feed' | 'forward'>;
function concrete<S>(A: Scalars<S>, state: S[], to: Effects<S>): Domain<S> {
  return {
    num: A.num,
    bin: A.bin,
    un: A.un,
    select: (c, a, b) => (A.truth(c) ? a : b),
    let: (_n, v) => v,
    cell: (_n, init) => {
      let v = init;
      return { get: () => v, set: (x) => void (v = x) };
    },
    branch: (c, t, e) => (A.truth(c) ? t() : e()),
    emit: (vs) => to.emit(vs),
    feed: (vs) => to.feed(vs),
    state: (i) => ({ get: () => state[i], set: (v) => void (state[i] = v) }),
    forward: (stages) => to.forward(stages),
  };
}

// `resolve` finds the processes a mid-stream ⇒ names. With it, `⇒` means
// what it meant in the original C runtime: this process *becomes* the
// pipeline, which receives the rest of the input (no defunctionalization).
type Resolve = (name: string) => KernelContext | undefined;
export const interpretKernel = (P: Program, c: KernelContext, paramValues: number[], resolve?: Resolve): Op =>
  interpret(reals, P, c, paramValues, resolve);
// The same on another kind of number: the parameters, like the tokens, as
// that kind writes them.
export const interpretKernelIn = <S>(A: Scalars<S>, P: Program, c: KernelContext, paramValues: Token, resolve?: Resolve): Op =>
  interpret(A, P, c, A.read(paramValues), resolve);

function interpret<S>(A: Scalars<S>, P: Program, { kernel: k, params, stream }: KernelContext, paramValues: S[], resolve?: Resolve): Op {
  let emit = (_t: Token) => {};
  const queue: S[][] = []; // feedback: LIFO, as the runtime drains it
  const state: S[] = [];
  let became: Op | null = null; // after ⇒: the pipeline this process became
  const D = concrete(A, state, {
    emit: (vs) => emit(A.write(vs)),
    feed: (vs) => void queue.push(vs),
    forward: (stages) => {
      if (!resolve) throw new Error('mid-stream ⇒ needs a resolver');
      const ops = stages.flatMap((st) => {
        if (!st) return []; // (→)
        const c = resolve(st.name) ?? (() => { throw new Error(`⇒ to unknown '${st.name}'`); })();
        return [interpret(A, P, c, st.args, resolve)];
      });
      became = ops.length > 0 ? pipeline(ops) : identity();
      became.setEmit((t) => emit(t));
    },
  });
  const p = paramEnv(params, (shape, at) => fromExprs(shape, paramValues, at));
  const sem = new Semantics(P, D).kernel(k, p.env, stream);
  state.push(...sem.initial);
  let seeded = false;
  const seed = () => {
    if (!seeded) {
      seeded = true;
      sem.prologue();
    }
  };
  const drain = () => {
    while (queue.length > 0) {
      if (became) {
        // Tokens still pending go to the new pipeline, in the order they
        // would have been consumed.
        for (const t of queue.splice(0).reverse()) became.push(A.write(t));
        return;
      }
      sem.step(fromExprs(stream.input, queue.pop()!));
    }
  };
  return {
    push(t) {
      seed();
      if (became) return became.push(t);
      queue.push(A.read(t));
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

// A kernel on numbers that does not run its own ⇒ but says what each phase
// did: the tokens it emitted, those it fed back, and the stages it became
// (null if none). streams.mooi says what follows from that.
export interface Did {
  out: Token[];
  fed: Token[];
  became: Parameters<Domain<number>['forward']>[0] | null;
}
export interface Steps {
  prologue(): Did;
  step(t: Token): Did;
  flush(): Did;
}
export function kernelSteps(P: Program, { kernel: k, params, stream }: KernelContext, paramValues: number[]): Steps {
  let did: Did = { out: [], fed: [], became: null };
  const state: number[] = [];
  const D = concrete(reals, state, {
    emit: (vs) => void did.out.push(vs),
    feed: (vs) => void did.fed.push(vs),
    forward: (stages) => void (did.became = stages),
  });
  const p = paramEnv(params, (shape, at) => fromExprs(shape, paramValues, at));
  const sem = new Semantics(P, D).kernel(k, p.env, stream);
  state.push(...sem.initial);
  const phase = (f: () => void) => {
    did = { out: [], fed: [], became: null };
    f();
    return did;
  };
  return {
    prologue: () => phase(sem.prologue),
    step: (t) => phase(() => sem.step(fromExprs(stream.input, t))),
    flush: () => phase(sem.flush),
  };
}
