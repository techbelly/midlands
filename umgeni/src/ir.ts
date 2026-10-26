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
//                   runs of kernels grouped into FusedSegments. A PipelineIR
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
  init: Stmt[];
  // Per-token body. Input pattern names are pre-resolved to 'input' slots.
  body: Stmt[];
  // Flush body, run at end of stream. May emit; must not feed.
  epilogue: Stmt[];
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
// and consecutive kernels are grouped into segments. Codegen turns each
// kernel segment into one op whose stages call each other directly with
// scalar arguments — no token arrays or queues between fused stages. SortBy
// is a buffering barrier, so it always splits segments.
export interface FusedIR {
  k: 'fused';
  name: string;
  paramWidth: number;
  segments: FusedSegment[];
}
export type FusedSegment =
  | { k: 'kernels'; stages: FusedStage[] }
  | Exclude<StageIR, { k: 'stage' }>; // whole-stream stages: the barriers (sortBy, groupBy, reduceBy, reverse), identity, dupCat, dupZip
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
  // time (rt.provide). A pipeline uses one like any stage.
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
  for (const s of f.segments) {
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

// Every kernel in a module, rewritten by f: on its own, or inside a fused
// segment. A pipeline (left unfused only when fusion bailed) holds none.
export function mapKernels(mod: ModuleIR, f: (k: KernelIR) => KernelIR): ModuleIR {
  const process = (p: ProcessIR): ProcessIR =>
    p.k === 'kernel' ? f(p)
    : p.k === 'fused' ? { ...p, segments: p.segments.map((seg) => (seg.k === 'kernels' ? { ...seg, stages: seg.stages.map((st) => ({ ...st, kernel: f(st.kernel) })) } : seg)) }
    : p;
  return { ...mod, processes: mod.processes.map(process) };
}

// Rebuild an expression with each leaf (const/param/state/input/local) mapped.
export function mapExpr(e: ScalarExpr, leaf: (e: ScalarExpr) => ScalarExpr): ScalarExpr {
  switch (e.k) {
    case 'bin': return { ...e, a: mapExpr(e.a, leaf), b: mapExpr(e.b, leaf) };
    case 'un': return { ...e, a: mapExpr(e.a, leaf) };
    case 'select': return { ...e, cond: mapExpr(e.cond, leaf), then: mapExpr(e.then, leaf), else: mapExpr(e.else, leaf) };
    default: return leaf(e);
  }
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

