// Mid-stream substitution (`⇒` inside a process body), compiled away.
//
// Nile semantics (the original C runtime is the reference): `⇒ S1 → … → Sn`
// replaces the running process with that pipeline, which receives the rest of
// the input. A process with no ∀ (a *generator*) runs its prologue and then
// removes itself — it emits a finite sequence and becomes the identity.
//
// That makes every substitution gezira uses expressible in first-order Nile:
//
//  - Generators are calls. `⇒ A → B` among generators emits B's sequence, then
//    A's — exactly the LIFO order of `<< A << B`. So a generator invocation is
//    a *frame* token (tag, args…) fed back into one `gen` kernel that runs the
//    tagged generator's body. Recursion (OffsetBezier, RoundJoin) is the same
//    depth-first feedback worklist `<<` already compiles to.
//  - A stream process that substitutes `⇒ S1 → G2 → … → Gn` (G's generators)
//    emits Gn…G2's frames and then *becomes* S1. Becoming is a state update:
//    the `head` kernel's state is (which process am I, its params, its state),
//    so `⇒ OffsetAndJoin(…, Zj) → …` is just a primed-state write.
//
// So a process using `⇒` mid-stream compiles to the ordinary pipeline
// `P#head → P#gen`; the head's own `>>` outputs travel as tag-0 frames.
// Nothing here survives into the IR that later passes see.

import { mapExpr, type KernelIR, type PipelineIR, type ScalarExpr, type Stmt } from './ir.js';

// The transient statement elaboration produces for `⇒` (null stage: `(→)`).
// Only this module consumes it.
export interface ForwardStmt {
  k: 'forward';
  stages: ({ name: string; args: ScalarExpr[] } | null)[];
}

// Statements as staging leaves them: the IR's, with ⇒ still among them (at
// any depth of if). A StagedKernel is a kernel of those; plainKernel is the
// way back to a KernelIR for a kernel that has no ⇒.
export type StagedStmt =
  | Exclude<Stmt, { k: 'if' }>
  | { k: 'if'; cond: ScalarExpr; then: StagedStmt[]; else: StagedStmt[] }
  | ForwardStmt;
export interface StagedKernel extends Omit<KernelIR, 'init' | 'body' | 'epilogue'> {
  init: StagedStmt[];
  body: StagedStmt[];
  epilogue: StagedStmt[];
}
export function plainKernel(k: StagedKernel): KernelIR {
  const plain = (ss: StagedStmt[]): Stmt[] => ss.map((s) => {
    if (s.k === 'forward') throw new Error(`'${k.name}': a mid-stream ⇒ in a kernel not compiled as a family`);
    return s.k === 'if' ? { ...s, then: plain(s.then), else: plain(s.else) } : s;
  });
  return { ...k, init: plain(k.init), body: plain(k.body), epilogue: plain(k.epilogue) };
}

export interface Generator {
  name: string;
  paramWidth: number;
  body: StagedStmt[]; // params read frame slots input[1..]
}

export interface Family {
  root: string; // the process being compiled
  paramWidth: number;
  inputWidth: number;
  outputWidth: number;
  members: StagedKernel[]; // stream processes it can become; members[0] = root unless root is a generator
  generators: Generator[];
}

export class SubstError extends Error {}

// Substitution chains (a member becoming a member becoming…) are inlined,
// so they end somewhere: this deep.
const MAX_SUBSTITUTION_DEPTH = 8;

const c = (value: number): ScalarExpr => ({ k: 'const', value });
const st = (index: number): ScalarExpr => ({ k: 'state', index });
const eq = (a: ScalarExpr, b: ScalarExpr): ScalarExpr => ({ k: 'bin', op: 'eq', a, b });
const setState = (index: number, expr: ScalarExpr): Stmt => ({ k: 'setState', index, expr });
const block = (stmts: Stmt[]): Stmt => ({ k: 'if', cond: c(1), then: stmts, else: [] });

// if (tag = k0) … else if (tag = k1) … — one dispatch per token.
function dispatch(tag: ScalarExpr, arms: { key: number; stmts: Stmt[] }[]): Stmt[] {
  return arms.reduceRight<Stmt[]>((rest, arm) => [{ k: 'if', cond: eq(tag, c(arm.key)), then: arm.stmts, else: rest }], []);
}

// `⇒` ends the process, so nothing may follow it: it must be the last
// statement of its block, in a block that is itself last, and so on outward.
function checkTail(stmts: StagedStmt[], tail: boolean, where: string): void {
  stmts.forEach((s, i) => {
    const t = tail && i === stmts.length - 1;
    if (s.k === 'forward' && !t) throw new SubstError(`${where}: statements follow a mid-stream ⇒`);
    if (s.k === 'if') {
      checkTail(s.then, t, where);
      checkTail(s.else, t, where);
    }
  });
}

export function assembleFamily(f: Family): (KernelIR | PipelineIR)[] {
  const genIndex = new Map(f.generators.map((g, i) => [g.name, i + 1])); // tag 0 = output payload
  const memberIndex = new Map(f.members.map((m, i) => [m.name, i]));
  const frameWidth = 1 + Math.max(f.outputWidth, ...f.generators.map((g) => g.paramWidth));
  const frame = (tag: number, values: ScalarExpr[]): ScalarExpr[] =>
    [c(tag), ...values, ...Array.from({ length: frameWidth - 1 - values.length }, () => c(0))];
  const genFrame = (stage: { name: string; args: ScalarExpr[] }, where: string): ScalarExpr[] => {
    const tag = genIndex.get(stage.name);
    if (tag === undefined) throw new SubstError(`${where}: '${stage.name}' is not a generator, so only the first stage of a mid-stream ⇒ may name it`);
    return frame(tag, stage.args);
  };

  // --- head: state = [tag, then per member: params ++ own state] ---
  const PASS = -1;
  const bases: number[] = [];
  let width = 1;
  for (const m of f.members) {
    bases.push(width);
    width += m.paramWidth + m.stateInit.length;
  }
  const relocate = (mi: number) => (e: ScalarExpr): ScalarExpr => mapExpr(e, (leaf) =>
    leaf.k === 'param' ? st(bases[mi] + leaf.index)
    : leaf.k === 'state' ? st(bases[mi] + f.members[mi].paramWidth + leaf.index)
    : leaf);

  let fresh = 0;
  // Rewrite member mi's statements into head space; inlined code gets fresh
  // local names so it can never shadow the code it is spliced into.
  function lower(stmts: StagedStmt[], mi: number, atEnd: boolean, depth: number, rename: (n: string) => string): Stmt[] {
    const r = relocate(mi);
    const rx = (e: ScalarExpr) => mapExpr(r(e), (l) => (l.k === 'local' ? { k: 'local', name: rename(l.name) } : l));
    const where = `'${f.members[mi].name}' in '${f.root}'`;
    return stmts.flatMap((s): Stmt[] => {
      switch (s.k) {
        case 'let': return [{ k: 'let', name: rename(s.name), expr: rx(s.expr) }];
        case 'assign': return [{ k: 'assign', name: rename(s.name), expr: rx(s.expr) }];
        case 'setState': return [setState(bases[mi] + f.members[mi].paramWidth + s.index, rx(s.expr))];
        case 'emit': return [{ k: 'emit', values: frame(0, s.values.map(rx)) }];
        case 'feed': return [{ k: 'feed', values: s.values.map(rx) }];
        case 'if': return [{
          k: 'if', cond: rx(s.cond),
          then: lower(s.then, mi, atEnd, depth, rename), else: lower(s.else, mi, atEnd, depth, rename),
        }];
        case 'forward': {
          if (depth > MAX_SUBSTITUTION_DEPTH) throw new SubstError(`${where}: substitution chain too deep`);
          const stages = s.stages.map((g) => g && { name: g.name, args: g.args.map(rx) });
          const out: Stmt[] = [];
          // Downstream generators run first, last stage first.
          for (let i = stages.length - 1; i >= 1; i--) {
            const g = stages[i];
            if (g) out.push({ k: 'emit', values: genFrame(g, where) });
          }
          const head = stages[0];
          if (head === null) return [...out, setState(0, c(PASS))];
          if (genIndex.has(head.name)) return [...out, { k: 'emit', values: genFrame(head, where) }, setState(0, c(PASS))];
          const ni = memberIndex.get(head.name);
          if (ni === undefined) throw new SubstError(`${where}: unknown substitution target '${head.name}'`);
          return [...out, ...become(ni, head.args, atEnd, depth)];
        }
      }
    });
  }

  // Become member ni: bind its params (via temporaries — the args may read
  // the very slots being overwritten), initialize its state, run its
  // prologue; at end of stream it is immediately flushed too.
  function become(ni: number, args: ScalarExpr[], atEnd: boolean, depth: number): Stmt[] {
    const n = fresh++;
    const m = f.members[ni];
    const inner = (x: string) => `${x}#i${n}`;
    return [
      ...args.map((a, i): Stmt => ({ k: 'let', name: `b#${n}#${i}`, expr: a })),
      ...args.map((_, i) => setState(bases[ni] + i, { k: 'local', name: `b#${n}#${i}` })),
      ...m.stateInit.map((e, i) => setState(bases[ni] + m.paramWidth + i, relocate(ni)(e))),
      block(lower(m.init, ni, atEnd, depth + 1, inner)),
      setState(0, c(ni)),
      ...(atEnd ? [block(lower(m.epilogue, ni, true, depth + 1, inner))] : []),
    ];
  }

  const same = (x: string) => x;
  for (const m of f.members) {
    for (const part of [m.init, m.body, m.epilogue]) checkTail(part, true, `'${m.name}' in '${f.root}'`);
  }
  const inputs = Array.from({ length: f.inputWidth }, (_, i): ScalarExpr => ({ k: 'input', index: i }));
  const params = Array.from({ length: f.paramWidth }, (_, i): ScalarExpr => ({ k: 'param', index: i }));
  const rootIsGenerator = genIndex.has(f.root);

  const stateInit: ScalarExpr[] = [c(rootIsGenerator ? PASS : 0)];
  f.members.forEach((m, mi) => {
    if (mi === 0 && !rootIsGenerator) stateInit.push(...params, ...m.stateInit.map(relocate(0)));
    else stateInit.push(...Array.from({ length: m.paramWidth + m.stateInit.length }, () => c(0)));
  });

  const head: KernelIR = {
    k: 'kernel', name: `${f.root}#head`,
    paramWidth: f.paramWidth, inputWidth: f.inputWidth, outputWidth: frameWidth,
    stateInit,
    init: rootIsGenerator
      ? [{ k: 'emit', values: frame(genIndex.get(f.root)!, params) }]
      : lower(f.members[0].init, 0, false, 0, same),
    body: dispatch(st(0), [
      { key: PASS, stmts: [{ k: 'emit', values: frame(0, inputs) }] },
      ...f.members.map((m, mi) => ({ key: mi, stmts: lower(m.body, mi, false, 0, same) })),
    ]),
    epilogue: dispatch(st(0), f.members.map((m, mi) => ({ key: mi, stmts: lower(m.epilogue, mi, true, 0, same) }))),
  };

  // --- gen: the frame interpreter. A generator's `⇒` feeds its stages back
  // first-to-last, so the LIFO worklist runs them last-to-first. ---
  const toFeeds = (stmts: StagedStmt[], where: string): Stmt[] => stmts.flatMap((s): Stmt[] => {
    if (s.k === 'if') return [{ ...s, then: toFeeds(s.then, where), else: toFeeds(s.else, where) }];
    if (s.k !== 'forward') return [s];
    return s.stages.flatMap((g): Stmt[] => (g ? [{ k: 'feed', values: genFrame(g, where) }] : []));
  });
  const tag: ScalarExpr = { k: 'input', index: 0 };
  const payload = Array.from({ length: f.outputWidth }, (_, i): ScalarExpr => ({ k: 'input', index: 1 + i }));
  const gen: KernelIR = {
    k: 'kernel', name: `${f.root}#gen`,
    paramWidth: 0, inputWidth: frameWidth, outputWidth: f.outputWidth,
    stateInit: [], init: [], epilogue: [],
    body: dispatch(tag, [
      { key: 0, stmts: [{ k: 'emit', values: payload }] },
      ...f.generators.map((g, i) => {
        checkTail(g.body, true, `generator '${g.name}'`);
        return { key: i + 1, stmts: toFeeds(g.body, `generator '${g.name}'`) };
      }),
    ]),
  };

  const pipeline: PipelineIR = {
    k: 'pipeline', name: f.root, paramWidth: f.paramWidth,
    stages: [{ k: 'stage', name: head.name, args: [params] }, { k: 'stage', name: gen.name, args: [] }],
  };
  return [head, gen, pipeline];
}
