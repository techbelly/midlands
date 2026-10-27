// The AST is plain serializable data: every node is a JSON-able object with a
// `kind` tag. No classes, no methods — downstream passes (IR construction,
// pretty-printing, inspection) consume it as data. The functions at the end
// are the questions the elaborator asks of a process.

export type TopLevel = TypeDef | ProcessTypeDef | OpDef | Process;

export interface Module {
  kind: 'module';
  decls: TopLevel[];
}

// --- types ---
export type Type = NamedType | TupleType | RecordType;

export interface NamedType {
  kind: 'namedType';
  name: string;
}
export interface TupleType {
  kind: 'tupleType';
  elements: Type[];
}
export interface RecordType {
  kind: 'recordType';
  fields: { names: string[]; type: Type }[];
}
export interface StreamType {
  kind: 'streamType';
  input: Type;
  output: Type;
}
export type ProcessType = StreamType | NamedType;

// --- top-level declarations ---
export interface TypeDef {
  kind: 'typeDef';
  name: string;
  type: Type;
}
export interface ProcessTypeDef {
  kind: 'processTypeDef';
  name: string;
  params: Param[] | null;
  type: ProcessType;
}
export interface Param {
  names: string[];
  type: Type;
}

export type Fixity = 'infix' | 'prefix' | 'outfix';
export interface OpDef {
  kind: 'opDef';
  fixity: Fixity;
  op: string; // for outfix, the opening glyphs
  closeOp: string | null; // for outfix, the closing glyphs
  params: { name: string; type: Type }[];
  resultType: Type;
  body: Expr;
}

export interface Process {
  kind: 'process';
  name: string;
  params: Param[] | null;
  type: ProcessType;
  prologue: Stmt[];
  // Zero or more ∀ arms. Plain kernels have one (cons: null); windowed
  // kernels have a `p ∷ q` arm and usually a `p ∷ ∅` end arm.
  forAlls: ForAll[];
  flush: Stmt[];
}
export interface ForAll {
  kind: 'forAll';
  pattern: Pattern;
  // `p ∷ q` → the successor pattern; `p ∷ ∅` → 'end'; plain ∀ → null.
  cons: Pattern | 'end' | null;
  // `p ∷ q by @key` — the window is segmented: pairs never span a key
  // change; the ∅ arm fires at each segment end.
  consKey: string | null;
  // `with H = +[ h ] by @y` — exclusive running reduction within key groups.
  scan: ScanClause | null;
  body: Stmt[];
}
export interface ScanClause {
  name: string;
  op: string; // operator glyphs, e.g. '+'
  expr: Expr;
  key: string; // field name of the input type
}

// --- statements ---
export type Stmt = OutStmt | InStmt | IfStmt | Forwarding | Decl | Assign | PatAssign;

export interface OutStmt {
  kind: 'out';
  exprs: Expr[];
}
export interface InStmt {
  kind: 'in';
  exprs: Expr[];
}
export interface IfStmt {
  kind: 'if';
  cond: Expr;
  then: Stmt[];
  else: Stmt[] | null; // an else-if chain nests as a single IfStmt in `else`
}
export interface Forwarding {
  kind: 'forward';
  pipeline: PipelineElem[];
}
export interface Decl {
  kind: 'decl';
  name: string;
  type: Type | null;
  value: Expr;
}
// `x' = e` — the next value of an existing binding.
export interface Assign {
  kind: 'assign';
  name: string; // without the prime
  value: Expr;
}
export interface PatAssign {
  kind: 'patAssign';
  pattern: Pattern;
  value: Expr;
}

// --- patterns ---
export type Pattern = VarPattern | WildcardPattern | TuplePattern;
export interface VarPattern {
  kind: 'varPat';
  name: string;
}
export interface WildcardPattern {
  kind: 'wildcardPat';
}
export interface TuplePattern {
  kind: 'tuplePat';
  elements: Pattern[];
}

// --- pipelines ---
export type PipelineElem = StageApp | StageRef | IdentityPipeline | GroupByStage | ReduceByStage;
// GroupBy promises key order only; within-group arrival order is
// unspecified unless `stable`.
export interface GroupByStage {
  kind: 'groupBy';
  keys: string[]; // major first
  stable: boolean;
}
export interface ReduceByStage {
  kind: 'reduceBy';
  keys: string[];
  fields: { name: string; op: string }[];
}
export interface StageApp {
  kind: 'stageApp';
  name: string;
  args: StageArg[];
}
export interface StageRef {
  kind: 'stageRef';
  name: string;
}
export interface IdentityPipeline {
  kind: 'identityPipeline';
}
export type StageArg =
  | Expr // includes bare identifiers; param-vs-kernel resolution is semantic
  | StageApp
  | { kind: 'pipelineArg'; elements: PipelineElem[] };

// --- expressions ---
export type Expr =
  | NumLit
  | Var
  | BinOp
  | UnOp
  | CondExpr
  | TupleExpr
  | FieldAccess
  | TypedExpr
  | OffsetRef;

export interface NumLit {
  kind: 'num';
  value: number;
}
export interface Var {
  kind: 'var';
  name: string;
}
export interface BinOp {
  kind: 'binOp';
  op: string;
  left: Expr;
  right: Expr;
}
// op is the whole shape: '-_', '√_', '¬_', '^_', '|_|', '‖_‖', '⌊_⌋', '⌈_⌉'
export interface UnOp {
  kind: 'unOp';
  op: string;
  operand: Expr;
}
export interface CondExpr {
  kind: 'cond';
  cases: { value: Expr; cond: Expr }[];
  otherwise: Expr;
}
export interface TupleExpr {
  kind: 'tuple';
  elements: Expr[];
}
export interface FieldAccess {
  kind: 'field';
  object: Expr;
  field: string;
}
export interface TypedExpr {
  kind: 'typed';
  expr: Expr;
  type: Type;
}
export interface OffsetRef {
  kind: 'offset';
  field: string;
}

// --- questions about a process, asked by the elaborator ---

// A body that is just `⇒ pipeline` is a pipeline definition: that pipeline.
export function pipelineBody(d: Process): PipelineElem[] | null {
  const p = d.prologue[0];
  return d.forAlls.length === 0 && d.flush.length === 0 && d.prologue.length === 1 && p.kind === 'forward' ? p.pipeline : null;
}
// Every statement of a process, in order: prologue, each ∀ body, flush body.
export const processStmts = (d: Process): Stmt[] => [...d.prologue, ...d.forAlls.flatMap((f) => f.body), ...d.flush];
// Every statement, including those nested in if branches.
function* allStmts(list: Stmt[]): IterableIterator<Stmt> {
  for (const s of list) {
    yield s;
    if (s.kind === 'if') {
      yield* allStmts(s.then);
      yield* allStmts(s.else ?? []);
    }
  }
}
export const hasForward = (stmts: Stmt[]) => [...allStmts(stmts)].some((s) => s.kind === 'forward');
// The process names a statement list substitutes into.
export const forwardTargets = (stmts: Stmt[]): string[] =>
  [...allStmts(stmts)].flatMap((s) => (s.kind === 'forward' ? s.pipeline : []))
    .flatMap((e) => (e.kind === 'stageApp' || e.kind === 'stageRef' ? [e.name] : []));
