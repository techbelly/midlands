// The symbolic domain: scalars are IR expressions, effects are recorded as
// IR statements. Running the semantics (semantics.ts) in this domain
// produces scalar IR — elaboration as staged interpretation (nile.mooi).

import type * as A from '../ast.js';
import type { KernelIR, ScalarExpr, Stmt } from '../ir.js';
import type { ForwardStmt, Generator } from '../substitute.js';
import { fromSlots, shapeWidth, type Shape, type Value } from '../values.js';
import type { Domain, Program } from './domain.js';
import { Semantics } from './nile.js';

// An IR builder: the domain, plus `record` to capture the statements an
// action performs.
export function irDomain() {
  let block: Stmt[] = [];
  const used = new Set<string>();
  // Names are unique per builder (a pattern temp or a re-declared name in one
  // scope must not shadow: JS and WGSL lets are block-scoped).
  const fresh = (name: string) => {
    let n = name;
    for (let i = 1; used.has(n); i++) n = `${name}#u${i}`;
    used.add(n);
    return n;
  };
  const record = (f: () => void): Stmt[] => {
    const saved = block;
    block = [];
    f();
    const out = block;
    block = saved;
    return out;
  };
  const D: Domain<ScalarExpr> = {
    num: (value) => ({ k: 'const', value }),
    bin: (op, a, b) => ({ k: 'bin', op, a, b }),
    un: (op, a) => ({ k: 'un', op, a }),
    select: (cond, then, els) => ({ k: 'select', cond, then, else: els }),
    let(name, expr) {
      const n = fresh(name);
      block.push({ k: 'let', name: n, expr });
      return { k: 'local', name: n };
    },
    cell(name, init) {
      const n = fresh(name);
      block.push({ k: 'let', name: n, expr: init });
      return { get: () => ({ k: 'local', name: n }), set: (expr) => void block.push({ k: 'assign', name: n, expr }) };
    },
    branch(cond, then, els) {
      const t = record(then);
      const e = record(els);
      block.push({ k: 'if', cond, then: t, else: e });
    },
    emit: (values) => void block.push({ k: 'emit', values }),
    feed: (values) => void block.push({ k: 'feed', values }),
    state: (index) => ({ get: () => ({ k: 'state', index }), set: (expr) => void block.push({ k: 'setState', index, expr }) }),
    forward: (stages) => void block.push({ k: 'forward', stages } satisfies ForwardStmt as unknown as Stmt),
  };
  return { D, record };
}

// Parameters as a value: one part per name, reading consecutive slots.
function paramValue(params: { names: string[]; shape: Shape }[], kind: 'param' | 'input', from: number) {
  let at = from;
  const parts = params.flatMap((g) => g.names.map(() => {
    const v = fromSlots(g.shape, kind, at);
    at += shapeWidth(g.shape);
    return v;
  }));
  const value: Value<ScalarExpr> = { k: 'agg', shape: { k: 'record', name: null, fields: [] }, parts };
  return { value, width: at - from };
}

export function stageKernel(
  P: Program,
  k: A.Kernel, // desugared
  params: { names: string[]; shape: Shape }[],
  sig: { input: Shape; output: Shape },
  access: KernelIR['access'],
): KernelIR {
  const { D, record } = irDomain();
  const p = paramValue(params, 'param', 0);
  const sem = new Semantics(P, D).kernel(k, p.value, params.map((g) => g.names), sig);
  return {
    k: 'kernel', name: k.name, paramWidth: p.width,
    inputWidth: shapeWidth(sig.input), outputWidth: shapeWidth(sig.output),
    stateInit: sem.initial,
    init: record(sem.init),
    body: record(() => sem.step(fromSlots(sig.input, 'input', 0))),
    epilogue: record(sem.flush),
    ...(access ? { access } : {}),
  };
}

// A generator's prologue, for the frame interpreter (substitute.ts): its
// parameters are the frame's slots after the tag; declarations are locals.
export function stageGenerator(
  P: Program,
  k: A.Kernel,
  params: { names: string[]; shape: Shape }[],
  sig: { input: Shape; output: Shape },
): Generator {
  const { D, record } = irDomain();
  const p = paramValue(params, 'input', 1);
  const env = new Map<string, Value<ScalarExpr>>();
  let i = 0;
  for (const g of params) for (const n of g.names) env.set(n, (p.value as { parts: Value<ScalarExpr>[] }).parts[i++]);
  const body = record(() => new Semantics(P, D).stmts(k.prologue, env, { ...sig, flush: true }));
  return { name: k.name, paramWidth: p.width, body };
}

// A pure expression (pipeline and template arguments): no effects.
export function stageExpr(P: Program, e: A.Expr, env: Map<string, Value<ScalarExpr>>): Value<ScalarExpr> {
  return new Semantics(P, irDomain().D).expr(e, env);
}
