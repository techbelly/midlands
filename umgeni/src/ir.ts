// The IR: one tree, read top down.
//
//   ModuleIR      the compiled library: its processes, plus what a host needs
//                 (host-supplied processes, parameter names, token layouts)
//   ProcessIR     a process is one of
//     KernelIR      a kernel: state, a prologue, a per-token body and a flush,
//                   all in scalar statements
//     PipelineIR    a wiring diagram: StageIR stages by name with arguments,
//                   or whole-stream builtins (sort, group, reduce, reverse…)
//     FusedIR       a pipeline after passes/fuse.ts: nested pipelines inlined,
//                   runs of kernels grouped into FusedRuns. A PipelineIR
//                   survives fusion only when fusion bailed.
//   Stmt, ScalarExpr   inside a kernel, where everything is flattened to
//                 scalars. Records and tuples are gone: a Bezier is six Reals,
//                 state is a vector of Reals, a token is a flat array of
//                 Reals. Broadcasting, operator inlining and componentwise
//                 lifting all happen during elaboration.
//
// Like the AST, the IR is plain serializable data. There is no SSA form and
// no CFG: expressions are trees, control flow is structured if/else, and the
// only mutable names are the primed state locals (passes/cse.ts handles
// those with versions). That maps 1:1 onto JS, WebAssembly and WGSL.

export type ScalarExpr =
  | { k: 'const'; value: number }
  | { k: 'param'; index: number }   // flattened kernel-parameter slot
  | { k: 'state'; index: number }   // flattened state slot
  | { k: 'input'; index: number }   // flattened current-token slot
  | { k: 'local'; name: string }
  | { k: 'bin'; op: BinOpName; a: ScalarExpr; b: ScalarExpr }
  | { k: 'un'; op: UnOpName; a: ScalarExpr }
  | { k: 'select'; cond: ScalarExpr; then: ScalarExpr; else: ScalarExpr };

// The scalar builtins. Everything else (user operators) is inlined away.
export type BinOpName =
  | 'add' | 'sub' | 'mul' | 'div'
  | 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne'
  | 'and' | 'or';
export type UnOpName = 'neg' | 'not' | 'sqrt' | 'floor' | 'ceil';

export type Stmt =
  | { k: 'let'; name: string; expr: ScalarExpr }     // first binding of a local
  | { k: 'assign'; name: string; expr: ScalarExpr }  // mutation (primed state locals)
  | { k: 'if'; cond: ScalarExpr; then: Stmt[]; else: Stmt[] }
  | { k: 'emit'; values: ScalarExpr[] }   // exactly outputWidth values
  // exactly inputWidth values (`<<`). `tail`: nothing runs after it, so it
  // is simply the stage's next token (marked by passes/tail.ts).
  | { k: 'feed'; values: ScalarExpr[]; tail?: true }
  | { k: 'setState'; index: number; expr: ScalarExpr };

export interface KernelIR {
  k: 'kernel';
  name: string;
  paramWidth: number;   // flattened parameter slot count
  inputWidth: number;   // flattened token widths
  outputWidth: number;
  // State slot initializers, evaluated in order against params (and, via
  // 'state' refs, earlier slots).
  stateInit: ScalarExpr[];
  // Non-declaration prologue statements, run once at process start (before
  // any input): seed feeds (RectangleSpans), or even emits (MiterJoin has no
  // ∀ and produces all its output here). Sees params and state, not input.
  prologue: Stmt[];
  // Per-token body. Input pattern names are pre-resolved to 'input' slots.
  body: Stmt[];
  // Flush body, run at end of stream. May emit; must not feed.
  flush: Stmt[];
  // Declared access patterns this kernel was written with. The bodies above
  // are the (already-lowered) sequential semantics; this records the
  // structure so a parallel backend can lower differently.
  access?: {
    scan?: { key: number; op: string; identity: number };
    // Window kernels: `key` is the declared segment field offset (`∷ … by
    // @key`), or null for an unsegmented window.
    window?: { key: number | null };
  };
}

// A kernel whose body is a single prologue `⇒ A → B → …`: a pipeline
// definition. Stage arguments are scalar expressions over the flattened
// parameter slots.
export interface PipelineIR {
  k: 'pipeline';
  name: string;
  paramWidth: number;
  stages: StageIR[];
}
export type StageIR =
  | { k: 'stage'; name: string; args: ScalarExpr[][] } // one flat vector per argument
  // Flattened field offsets, major first. Elaboration gives one key; fusion
  // joins `SortBy (@x) → SortBy (@y)` into one sort by (y, x).
  | { k: 'sortBy'; keyIndexes: number[] }
  | { k: 'identity' }
  // Whole-stream builtins: Reverse emits its input backwards at end of
  // stream; DupCat feeds every token to both branches and emits all of the
  // first branch's output, then all of the second's.
  | { k: 'reverse' }
  | { k: 'dupCat'; branches: [StageIR[], StageIR[]] }
  // DupZip: both branches see every token; their outputs pair up in order.
  | { k: 'dupZip'; branches: [StageIR[], StageIR[]] }
  // GroupBy: key order only (stable = arrival order within equal keys too).
  | { k: 'groupBy'; keyIndexes: number[]; stable: boolean }
  // ReduceBy: merge each key group to one token; `op` is a scalar expression
  // over the locals '#ra' and '#rb' (the two values being combined).
  | { k: 'reduceBy'; width: number; keyIndexes: number[]; fields: { index: number; op: ScalarExpr }[] };

// A pipeline after fusion (passes/fuse.ts): nested pipeline refs are inlined
// and consecutive kernels are grouped into runs. Codegen turns each
// kernel run into one op whose stages call each other directly with
// scalar arguments — no token arrays or queues between fused stages. SortBy
// is a buffering barrier, so it always splits runs.
export interface FusedIR {
  k: 'fused';
  name: string;
  paramWidth: number;
  runs: FusedRun[];
}
// A stage that is not a kernel: the barriers (sortBy, groupBy, reduceBy,
// reverse), identity, dupCat and dupZip; the runtime supplies each.
export type WholeStreamStage = Exclude<StageIR, { k: 'stage' }>;
export type FusedRun =
  | { k: 'kernels'; stages: FusedStage[] }
  | WholeStreamStage;
export interface FusedStage {
  name: string;
  kernel: KernelIR;
  // One flat vector per kernel parameter group, over the pipeline's params.
  args: ScalarExpr[][];
}

export type ProcessIR = KernelIR | PipelineIR | FusedIR;

export interface ModuleIR {
  processes: ProcessIR[];
  // Processes the host supplies: declared in Nile by their signature alone
  // (`ReadImage :: (img : Real) : Point >> Color`), defined by the host at run
  // time (api.provide). A pipeline uses one like any stage.
  host: HostProcess[];
  // Each process's parameters as its Nile signature names them, in order,
  // with their flattened widths: how a host can pass them by name.
  signatures: Record<string, ParamSig[]>;
  // Every named record type's layout: how a host reads or builds tokens by
  // field name.
  types: Record<string, TokenLayout>;
}

export interface HostProcess {
  name: string;
  paramWidth: number;
  inputWidth: number;
  outputWidth: number;
}

export interface ParamSig {
  name: string;
  width: number;
}

// A named record type's token layout: every field, by path (dotted for
// nested records: 'Z', 'Z.A', 'Z.A.x'), at its flattened offset and width.
export interface TokenLayout {
  width: number;
  fields: Record<string, { at: number; width: number }>;
}

// --- folds: the IR is a tree; these are its traversals -------------------------

// A fused pipeline's input width: that of its first kernel, or of the
// reduce that starts it. Null when nothing in it says.
export function inputWidthOf(f: FusedIR): number | null {
  for (const s of f.runs) {
    if (s.k === 'kernels') return s.stages[0].kernel.inputWidth;
    if (s.k === 'reduceBy') return s.width;
  }
  return null;
}

// The fused pipeline of that name: what a GPU host lowers. Throws when the
// module has no such process, or has one that is a kernel or did not fuse.
export function fusedPipeline(mod: ModuleIR, name: string): FusedIR {
  const p = mod.processes.find((p) => p.name === name);
  if (!p || p.k !== 'fused') throw new Error(`'${name}' is not a fused pipeline`);
  return p;
}

// The kernel of that name. Throws when the module has no such process, or
// has one that is a pipeline.
export function kernelOf(mod: ModuleIR, name: string): KernelIR {
  const p = mod.processes.find((p) => p.name === name);
  if (!p || p.k !== 'kernel') throw new Error(`'${name}' is not a kernel`);
  return p;
}

// Every kernel in a module, rewritten by f: on its own, or inside a fused
// run. A pipeline (left unfused only when fusion bailed) holds none.
export function mapKernels(mod: ModuleIR, f: (k: KernelIR) => KernelIR): ModuleIR {
  const process = (p: ProcessIR): ProcessIR =>
    p.k === 'kernel' ? f(p)
    : p.k === 'fused' ? { ...p, runs: p.runs.map((run) => (run.k === 'kernels' ? { ...run, stages: run.stages.map((st) => ({ ...st, kernel: f(st.kernel) })) } : run)) }
    : p;
  return { ...mod, processes: mod.processes.map(process) };
}

// An operation's subexpressions, in order (none for a leaf), and the same
// operation over new ones. The order is part of the IR's identity: CSE
// numbers what it shares by walking it.
export function operands(e: ScalarExpr): ScalarExpr[] {
  switch (e.k) {
    case 'bin': return [e.a, e.b];
    case 'un': return [e.a];
    case 'select': return [e.cond, e.then, e.else];
    default: return [];
  }
}
export function withOperands(e: ScalarExpr, xs: ScalarExpr[]): ScalarExpr {
  switch (e.k) {
    case 'bin': return { ...e, a: xs[0], b: xs[1] };
    case 'un': return { ...e, a: xs[0] };
    case 'select': return { ...e, cond: xs[0], then: xs[1], else: xs[2] };
    default: return e;
  }
}

// Rebuild an expression with each leaf (const/param/state/input/local) mapped.
export function mapExpr(e: ScalarExpr, leaf: (e: ScalarExpr) => ScalarExpr): ScalarExpr {
  const xs = operands(e);
  return xs.length === 0 ? leaf(e) : withOperands(e, xs.map((x) => mapExpr(x, leaf)));
}

// Every node of an expression, each before its operands.
export function* allNodes(e: ScalarExpr): Generator<ScalarExpr> {
  yield e;
  for (const x of operands(e)) yield* allNodes(x);
}

// Operation nodes (bin/un/select) in a tree: what the passes and the
// instrumentation count as work.
export function opCount(e: ScalarExpr): number {
  const xs = operands(e);
  return xs.length === 0 ? 0 : 1 + xs.reduce((n, x) => n + opCount(x), 0);
}

// The expressions a statement holds itself: an if's condition (its
// branches are statements of their own), an emit's or feed's values, the
// one expression of a let, an assign or a setState.
export function stmtExprs(s: Stmt): ScalarExpr[] {
  switch (s.k) {
    case 'if': return [s.cond];
    case 'emit': case 'feed': return s.values;
    default: return [s.expr];
  }
}

// The same statements with every expression rewritten by f, in the
// branches of an if too.
export function mapStmts(stmts: Stmt[], f: (e: ScalarExpr) => ScalarExpr): Stmt[] {
  return stmts.map((s) => mapStmt(s, f));
}
export function mapStmt(s: Stmt, f: (e: ScalarExpr) => ScalarExpr): Stmt {
  switch (s.k) {
    case 'if': return { ...s, cond: f(s.cond), then: mapStmts(s.then, f), else: mapStmts(s.else, f) };
    case 'emit': case 'feed': return { ...s, values: s.values.map(f) };
    default: return { ...s, expr: f(s.expr) };
  }
}

// How many times each local is read in these statements: what a pass
// needs to know whether a let is dead, or shared, or read just once.
export function localReads(stmts: Stmt[]): Map<string, number> {
  const reads = new Map<string, number>();
  for (const s of allStmts(stmts)) for (const e of stmtExprs(s)) for (const x of allNodes(e)) if (x.k === 'local') reads.set(x.name, (reads.get(x.name) ?? 0) + 1);
  return reads;
}

// A kernel's three regions of statements, each rewritten by f. They are
// separate scopes: a prologue runs once, a body per token, a flush at the
// end.
export function mapRegions(k: KernelIR, f: (stmts: Stmt[]) => Stmt[]): KernelIR {
  return { ...k, prologue: f(k.prologue), body: f(k.body), flush: f(k.flush) };
}

// A kernel's static size in operation nodes: statements and state
// initializers together.
export function kernelOpCount(k: KernelIR): number {
  let n = k.stateInit.reduce((m, e) => m + opCount(e), 0);
  for (const s of allStmts([...k.prologue, ...k.body, ...k.flush])) for (const e of stmtExprs(s)) n += opCount(e);
  return n;
}

// Every statement, including those nested in if branches.
export function* allStmts(list: Stmt[]): Generator<Stmt> {
  for (const s of list) {
    yield s;
    if (s.k === 'if') {
      yield* allStmts(s.then);
      yield* allStmts(s.else);
    }
  }
}
export const anyStmt = (list: Stmt[], pred: (s: Stmt) => boolean): boolean => {
  for (const s of allStmts(list)) if (pred(s)) return true;
  return false;
};

