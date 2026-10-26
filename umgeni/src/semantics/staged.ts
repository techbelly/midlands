// The symbolic domain: scalars are IR expressions, effects are recorded as
// IR statements. Running the semantics (nile.ts, nile.mooi) in this domain
// produces scalar IR — elaboration as staged interpretation.

import type * as A from '../ast.js';
import type { KernelIR, ScalarExpr } from '../ir.js';
import type { Generator, StagedKernel, StagedStmt } from '../substitute.js';
import { fromSlots, paramEnv, shapeWidth, type Value } from '../values.js';
import type { Domain, KernelContext, Program } from './domain.js';
import { Semantics } from './nile.js';

// An IR builder: the domain, plus `record` to capture the statements an
// action performs.
function irDomain() {
  let block: StagedStmt[] = [];
  const used = new Set<string>();
  // Names are unique per builder (a pattern temp or a re-declared name in one
  // scope must not shadow: JS and WGSL lets are block-scoped).
  const fresh = (name: string) => {
    let n = name;
    for (let i = 1; used.has(n); i++) n = `${name}#u${i}`;
    used.add(n);
    return n;
  };
  const record = (f: () => void): StagedStmt[] => {
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
    forward: (stages) => void block.push({ k: 'forward', stages }),
  };
  return { D, record };
}

export function stageKernel(P: Program, { kernel: k, params, stream }: KernelContext, access: KernelIR['access']): StagedKernel {
  const { D, record } = irDomain();
  const p = paramEnv(params, (shape, at) => fromSlots(shape, 'param', at));
  const sem = new Semantics(P, D).kernel(k, p.env, stream);
  return {
    k: 'kernel', name: k.name, paramWidth: p.width,
    inputWidth: shapeWidth(stream.input), outputWidth: shapeWidth(stream.output),
    stateInit: sem.initial,
    init: record(sem.init),
    body: record(() => sem.step(fromSlots(stream.input, 'input', 0))),
    epilogue: record(sem.flush),
    ...(access ? { access } : {}),
  };
}

// A generator's prologue, for the frame interpreter (substitute.ts): its
// parameters are the frame's slots after the tag; declarations are locals.
export function stageGenerator(P: Program, { kernel: k, params, stream }: KernelContext): Generator {
  const { D, record } = irDomain();
  const p = paramEnv(params, (shape, at) => fromSlots(shape, 'input', 1 + at));
  const body = record(() => new Semantics(P, D).stmts(k.prologue, p.env, { ...stream, flush: true }));
  return { name: k.name, paramWidth: p.width, body };
}

// A pure expression (pipeline and template arguments): no effects.
export function stageExpr(P: Program, e: A.Expr, env: Map<string, Value<ScalarExpr>>): Value<ScalarExpr> {
  return new Semantics(P, irDomain().D).expr(e, env);
}
