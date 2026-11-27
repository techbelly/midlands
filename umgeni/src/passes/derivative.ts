// A library as its own derivative. Every kernel is rewritten on dual numbers
// (semantics/dual.ts) in n directions: each expression becomes its value and
// n derivatives, each token, state slot and local as many times wider. What
// comes out is ordinary IR, so fusion, CSE, JavaScript and WebAssembly take
// it as they take anything: a derivative kernel is a kernel with wider
// tokens. (Two limits show at great width. WebAssembly passes a token as a
// function's parameters, of which it allows 1,000, so a Bezier has a wasm
// derivative in up to 165 directions. And the GPU lowering refuses a
// rasterizer's derivative as it stands: its grid holds keys and summed
// fields, and the keys' derivatives, though they are zero, are neither.)
//
// This is the interpreter on dual numbers, staged. Elaboration left each
// kernel as the arithmetic its meaning performs; the same rules
// (dualArithmetic) applied to that arithmetic give the same numbers the
// interpreter gives on duals, wherever the values themselves are finite.
// (Where a value is not, as in the arm of a choice that was not taken, the
// two may differ in a derivative nobody reads: a term left out here because
// it is known to be zero is NaN there.)
//
// The layout is dual.ts's: a token's w values, then each direction's w
// derivatives, so keys and fields keep their offsets and the stages that
// only move tokens (SortBy, GroupBy, Reverse, DupCat) are untouched. A
// ReduceBy by + adds each direction's copy of a field as it adds the field.
// State is laid out the same way. Parameters are constants: the derivative
// is with respect to the stream.
//
// Refused, by name and with the reason: a ReduceBy by anything but + (the
// derivative of a product or a minimum is not a reduction field by field),
// DupZip (it joins two tokens end to end, which is not this layout), and
// processes the host supplies (nobody knows their derivative).

import type { KernelIR, ModuleIR, PipelineIR, ProcessIR, ScalarExpr, StageIR, Stmt } from '../ir.js';
import { dualArithmetic, type Base, type Dual, type DualArithmetic } from '../semantics/dual.js';

type D = Dual<ScalarExpr>;
const ZERO: ScalarExpr = { k: 'const', value: 0 };
const expressions: Base<ScalarExpr> = {
  num: (value) => (value === 0 ? ZERO : { k: 'const', value }),
  bin: (op, a, b) => ({ k: 'bin', op, a, b }),
  un: (op, a) => ({ k: 'un', op, a }),
  select: (cond, then, els) => ({ k: 'select', cond, then, else: els }),
  zero: (e) => e.k === 'const' && e.value === 0,
};

class Refused extends Error {}

export function derivativeModule(ir: ModuleIR, n: number): { ir: ModuleIR; unsupported: { name: string; reason: string }[] } {
  const A = dualArithmetic(n, expressions);
  const host = new Set(ir.host.map((h) => h.name));
  const processes: ProcessIR[] = [];
  const unsupported: { name: string; reason: string }[] = [];
  for (const p of ir.processes) {
    try {
      if (p.k === 'kernel') processes.push(kernel(p, n, A));
      else if (p.k === 'pipeline') processes.push({ ...p, stages: stages(p.stages, n, host) });
      else throw new Refused('the derivative is taken before fusion');
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      unsupported.push({ name: p.name, reason: `no derivative: ${e.message}` });
    }
  }
  // A pipeline is only as good as its stages.
  const names = (ss: StageIR[]): string[] => ss.flatMap((s) => (s.k === 'stage' ? [s.name] : s.k === 'dupCat' || s.k === 'dupZip' ? s.branches.flatMap(names) : []));
  for (let changed = true; changed;) {
    changed = false;
    const have = new Set(processes.map((p) => p.name));
    for (const p of [...processes]) {
      if (p.k !== 'pipeline') continue;
      const missing = names(p.stages).find((s) => !have.has(s));
      if (missing === undefined) continue;
      processes.splice(processes.indexOf(p), 1);
      unsupported.push({ name: p.name, reason: `no derivative: it uses '${missing}', which has none` });
      changed = true;
    }
  }
  return { ir: { ...ir, processes, host: [] }, unsupported };
}

// --- pipelines ---

function stages(ss: StageIR[], n: number, host: Set<string>): PipelineIR['stages'] {
  return ss.map((s): StageIR => {
    switch (s.k) {
      case 'stage':
        if (host.has(s.name)) throw new Refused(`'${s.name}' is the host's, and nobody knows its derivative`);
        return s;
      case 'reduceBy': {
        const sum = (op: ScalarExpr) => op.k === 'bin' && op.op === 'add' && op.a.k === 'local' && op.b.k === 'local';
        if (!s.fields.every((f) => sum(f.op))) throw new Refused('a ReduceBy by an operator other than + is not a reduction field by field');
        const copies = Array.from({ length: n }, (_, j) => s.fields.map((f) => ({ ...f, index: (j + 1) * s.width + f.index })));
        return { ...s, width: s.width * (1 + n), fields: [...s.fields, ...copies.flat()] };
      }
      case 'dupCat':
        return { ...s, branches: [stages(s.branches[0], n, host), stages(s.branches[1], n, host)] };
      case 'dupZip':
        throw new Refused('DupZip joins two tokens end to end, which is not how a token carries its derivatives');
      default:
        return s;
    }
  });
}

// --- kernels ---

function kernel(k: KernelIR, n: number, A: DualArithmetic<ScalarExpr>): KernelIR {
  const w = k.inputWidth;
  const s = k.stateInit.length;
  // A local written after its first binding can come to move wherever it
  // did not at first, so each of its derivatives is a local of its own.
  const written = new Set<string>();
  const scan = (ss: Stmt[]): void => {
    for (const st of ss) {
      if (st.k === 'assign') written.add(st.name);
      else if (st.k === 'if') (scan(st.then), scan(st.else));
    }
  };
  for (const phase of [k.prologue, k.body, k.flush]) scan(phase);

  type Env = Map<string, D>;
  const slots = (kind: 'input' | 'state', width: number, i: number): D =>
    ({ v: { k: kind, index: i }, d: Array.from({ length: n }, (_, j): ScalarExpr => ({ k: kind, index: (j + 1) * width + i })) });
  const dual = (e: ScalarExpr, env: Env): D => {
    switch (e.k) {
      case 'const': return { v: e, d: new Array<ScalarExpr>(n).fill(ZERO) };
      case 'param': return { v: e, d: new Array<ScalarExpr>(n).fill(ZERO) };
      case 'input': return slots('input', w, e.index);
      case 'state': return slots('state', s, e.index);
      case 'local': {
        const x = env.get(e.name);
        if (!x) throw new Error(`derivative of '${k.name}': '${e.name}' is read before it is bound`);
        return x;
      }
      case 'bin': return A.bin(e.op, dual(e.a, env), dual(e.b, env));
      case 'un': return A.un(e.op, dual(e.a, env));
      case 'select': return A.select(dual(e.cond, env), dual(e.then, env), dual(e.else, env));
    }
  };
  // A token's values, then each direction's derivatives.
  const wide = (values: ScalarExpr[], env: Env): ScalarExpr[] => {
    const ds = values.map((v) => dual(v, env));
    return [...ds.map((x) => x.v), ...Array.from({ length: n }, (_, j) => ds.map((x) => x.d[j])).flat()];
  };
  const moving = (name: string, j: number) => `${name}#d${j}`;
  const stmts = (ss: Stmt[], outer: Env): Stmt[] => {
    const env: Env = new Map(outer); // a let is its block's
    return ss.flatMap((st): Stmt[] => {
      switch (st.k) {
        case 'let': {
          const x = dual(st.expr, env);
          const out: Stmt[] = [{ k: 'let', name: st.name, expr: x.v }];
          // What does not move, and never will, needs no local to say so.
          const d = x.d.map((dx, j): ScalarExpr => {
            if (expressions.zero(dx) && !written.has(st.name)) return ZERO;
            out.push({ k: 'let', name: moving(st.name, j), expr: dx });
            return { k: 'local', name: moving(st.name, j) };
          });
          env.set(st.name, { v: { k: 'local', name: st.name }, d });
          return out;
        }
        case 'assign': {
          // The derivatives first: they read the value as it was.
          const x = dual(st.expr, env);
          return [...x.d.map((dx, j): Stmt => ({ k: 'assign', name: moving(st.name, j), expr: dx })), { k: 'assign', name: st.name, expr: x.v }];
        }
        case 'if':
          return [{ k: 'if', cond: st.cond, then: stmts(st.then, env), else: stmts(st.else, env) }];
        case 'emit':
          return [{ k: 'emit', values: wide(st.values, env) }];
        case 'feed':
          return [{ ...st, values: wide(st.values, env) }];
        case 'setState': {
          const x = dual(st.expr, env);
          return [...x.d.map((dx, j): Stmt => ({ k: 'setState', index: (j + 1) * s + st.index, expr: dx })), { k: 'setState', index: st.index, expr: x.v }];
        }
      }
    });
  };
  const none: Env = new Map();
  const inits = k.stateInit.map((e) => dual(e, none));
  return {
    ...k,
    inputWidth: w * (1 + n),
    outputWidth: k.outputWidth * (1 + n),
    stateInit: [...inits.map((x) => x.v), ...Array.from({ length: n }, (_, j) => inits.map((x) => x.d[j])).flat()],
    prologue: stmts(k.prologue, none),
    body: stmts(k.body, none),
    flush: stmts(k.flush, none),
  };
}
