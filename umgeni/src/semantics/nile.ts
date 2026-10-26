// Nile's meaning: nile.mooi (the semantics) and values.mooi (the value
// algebra), bound to a domain and a program. Staged (staged.ts) it is the
// compiler's front end; on numbers (concrete.ts) it is an interpreter.

import type * as A from '../ast.js';
import type { BinOpName, UnOpName } from '../ir.js';
import { BIN, UN } from '../scalar.js';
import { ElabError, REAL, type Shape, type Value } from '../values.js';
import { load } from '../../../mooi/src/mooi.js';
import { prelude } from '../../../mooi/src/prelude.js';
import type { Domain, Program } from './domain.js';
import { nileSource, valuesSource } from './source.js';

const SOURCE = `${valuesSource}\n${nileSource}`;
const BIN_OF = new Map(Object.entries(BIN).map(([n, o]) => [o.nile, n as BinOpName]));
const UN_OF = new Map(Object.entries(UN).map(([n, o]) => [o.nile, n as UnOpName]));
const fail = (msg: string): never => {
  throw new ElabError(msg);
};

// Environments are persistent: binding makes a child (prototype chain), so
// threading them through statements costs O(1) per binding. What a name is
// bound to (a value, or the cells standing for x') is the equations' business.
type Env<S> = Record<string, unknown>;
const child = <S>(env: Env<S>): Env<S> => Object.create(env);
const fromMap = <S>(m: Map<string, Value<S>>): Env<S> => Object.assign(Object.create(null), Object.fromEntries(m));

// What Mooi cannot say itself: the domain, the program, the builtin
// operators, and environments.
function host<S>(D: Domain<S>, P: Program): Record<string, unknown> {
  return {
    ...prelude(fail),
    D, P, R: REAL, empty: Object.create(null),
    bind: (env: Env<S>, n: string, v: unknown) => Object.assign(child(env), { [n]: v }),
    bindAll: (env: Env<S>, ns: string[], vs: unknown[]) => Object.assign(child(env), Object.fromEntries(ns.map((n, i) => [n, vs[i]]))),
    bound: (env: Env<S>, n: string) => n in env,
    get: (env: Env<S>, n: string) => (n in env ? env[n] : null),
    primed: (n: string) => n.endsWith("'"),
    builtin: (op: string) => BIN_OF.has(op) || UN_OF.has(op),
    prim: (op: string, xs: S[]) => (xs.length === 2 ? D.bin(BIN_OF.get(op)!, xs[0], xs[1]) : D.un(UN_OF.get(op)!, xs[0])),
  };
}

type F = (...a: unknown[]) => unknown;

export class Semantics<S> {
  private m: Record<string, F>;
  constructor(P: Program, D: Domain<S>) {
    this.m = load(SOURCE, host(D, P)) as Record<string, F>;
  }
  expr(e: A.Expr, env: Map<string, Value<S>>): Value<S> {
    return this.m.expr(e, fromMap(env)) as Value<S>;
  }
  stmts(list: A.Stmt[], env: Map<string, Value<S>>, io: { input: Shape; output: Shape; flush?: boolean }): void {
    this.m.execs({ ...io, flush: io.flush ?? false }, list, fromMap(env));
  }
  kernel(k: A.Kernel, params: Value<S>, names: string[][], sig: { input: Shape; output: Shape }) {
    return this.m.kernel(k, (params as { parts: Value<S>[] }).parts, names.flat(), { ...sig, flush: false }) as {
      initial: S[];
      init: () => void;
      step: (input: Value<S>) => void;
      flush: () => void;
    };
  }
}
