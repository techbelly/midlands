import * as ohm from 'ohm-js';
import { nileGrammarSource } from './grammar/source.js';
import * as ast from './ast.js';
import { emptyOpTable, opExtensionSource, opKey, type OpTable } from './ops.js';
import { preprocessMapped } from './preprocess.js';

const coreSource = nileGrammarSource;
export const coreGrammar = ohm.grammar(coreSource);

export class ParseError extends Error {
  constructor(message: string, public line: number, public col: number) {
    super(`line ${line}, col ${col}: ${message}`);
  }
}

// --- pass 1: scan opDef headers to register prefix/outfix operators ---

interface OpInfo {
  fixity: 'infix' | 'prefix' | 'outfix';
  op: string;
  close: string | null;
}

const headerSemantics = coreGrammar.createSemantics().addOperation<OpInfo>('opInfo', {
  OpDefHeader_infix(_o1, _n1, _c1, _t1, _p1, op, _o2, _n2, _c2, _t2, _p2, _c3, _rt) {
    return { fixity: 'infix' as const, op: op.sourceString, close: null };
  },
  OpDefHeader_outfix(open, _o, _n, _c, _t, _p, close, _c2, _rt) {
    return { fixity: 'outfix' as const, op: open.sourceString, close: close.sourceString };
  },
  OpDefHeader_prefix(op, _o, _n, _c, _t, _p, _c2, _rt) {
    return { fixity: 'prefix' as const, op: op.sourceString, close: null };
  },
});

export function scanOpDefs(source: string, table: OpTable): void {
  for (const line of source.split('\n')) {
    if (line === '' || /^\s/.test(line)) continue;
    const m = coreGrammar.match(line.trimEnd(), 'OpDefHeader');
    if (m.failed()) continue;
    const info = headerSemantics(m).opInfo();
    if (info.fixity === 'infix') table.infix.add(info.op);
    else if (info.fixity === 'prefix') table.prefix.add(info.op);
    else table.outfix.set(info.op, info.close!);
  }
}

// --- pass 2: parse with the (possibly extended) grammar ---

interface CompiledGrammar {
  grammar: ohm.Grammar;
  semantics: ohm.Semantics;
}

const grammarCache = new Map<string, CompiledGrammar>();

function grammarForOps(table: OpTable): CompiledGrammar {
  const ext = opExtensionSource(table);
  const key = ext ?? '<core>';
  const cached = grammarCache.get(key);
  if (cached) return cached;

  const grammar = ext === null ? coreGrammar : ohm.grammar(ext, { Nile: coreGrammar });
  const actions: Record<string, (...children: ohm.Node[]) => unknown> = { ...astActions };
  [...table.outfix.entries()].forEach(([open, close], i) => {
    actions[`UserOutfix_o${i}`] = (_open: ohm.Node, e: ohm.Node, _close: ohm.Node) =>
      ({ kind: 'unOp', op: opKey('outfix', open, close), operand: e.toAST() }) as ast.UnOp;
  });
  const semantics = grammar.createSemantics().addOperation('toAST', actions);
  const compiled = { grammar, semantics };
  grammarCache.set(key, compiled);
  return compiled;
}

export interface ParseResult {
  module: ast.Module;
  table: OpTable;
}

// Parses one source file. `table` carries operators defined by earlier files
// (e.g. types.nl) and is extended with this file's definitions.
export function parseModule(source: string, table: OpTable = emptyOpTable()): ParseResult {
  scanOpDefs(source, table);
  const { grammar, semantics } = grammarForOps(table);
  const pre = preprocessMapped(source);
  const match = grammar.match(pre.text);
  if (match.failed()) {
    // Ohm's own position is within the preprocessed text; report the source's.
    const { line, col } = pre.position(match.getRightmostFailurePosition());
    const why = (match.shortMessage ?? 'parse error').replace(/^Line \d+, col \d+: /, '');
    throw new ParseError(why, line, col);
  }
  return { module: semantics(match).toAST() as ast.Module, table };
}

// Parses an ordered sequence of files sharing one operator table.
export function parseProgram(sources: string[]): { modules: ast.Module[]; table: OpTable } {
  const table = emptyOpTable();
  const modules = sources.map((src) => parseModule(src, table).module);
  return { modules, table };
}

// --- AST construction ---

type N = ohm.Node;

function optional<T>(node: N): T | null {
  return node.numChildren === 0 ? null : node.child(0).toAST();
}
function list<T>(node: N): T[] {
  return node.asIteration().children.map((c: N) => c.toAST());
}
function identList(node: N): string[] {
  return node.asIteration().children.map((c: N) => c.sourceString);
}
function iter<T>(node: N): T[] {
  return node.children.map((c: N) => c.toAST());
}
function binOp(left: N, op: N, right: N): ast.BinOp {
  return { kind: 'binOp', op: op.sourceString, left: left.toAST(), right: right.toAST() };
}
function unOp(op: string, operand: N): ast.UnOp {
  return { kind: 'unOp', op, operand: operand.toAST() };
}

const astActions: Record<string, (...children: N[]) => unknown> = {
  Start(tops) {
    return { kind: 'module', decls: iter(tops) } satisfies ast.Module;
  },

  // --- types ---
  TypeDef_record(name, _lt, type, _eol) {
    return { kind: 'typeDef', name: name.sourceString, type: type.toAST() } satisfies ast.TypeDef;
  },
  TypeDef_process(name, _dc, sig, _eol) {
    const s = sig.toAST();
    const { params, type } = s.kind === 'akType' ? s : { params: null, type: s };
    return { kind: 'processTypeDef', name: name.sourceString, params, type };
  },
  AType_record(_o, groups, _c) {
    return { kind: 'recordType', fields: list(groups) } satisfies ast.RecordType;
  },
  AType_tuple(_o, types, _c) {
    return { kind: 'tupleType', elements: list(types) } satisfies ast.TupleType;
  },
  AType_named(name) {
    return { kind: 'namedType', name: name.sourceString } satisfies ast.NamedType;
  },
  FieldGroup(names, _c, type) {
    return { names: identList(names), type: type.toAST() };
  },
  KType_stream(input, _a, output) {
    return { kind: 'streamType', input: input.toAST(), output: output.toAST() };
  },
  KType_named(name) {
    return { kind: 'namedType', name: name.sourceString };
  },
  AkType(_o, groups, _c, _colon, ktype) {
    return { kind: 'akType', params: list(groups), type: ktype.toAST() };
  },

  // --- operator definitions ---
  OpDef(header, _eol, body) {
    return { ...header.toAST(), body: body.toAST() } satisfies ast.OpDef;
  },
  OpDefHeader_infix(_o1, n1, _c1, t1, _p1, op, _o2, n2, _c2, t2, _p2, _c3, rt) {
    return {
      kind: 'opDef', fixity: 'infix', op: op.sourceString, closeOp: null,
      params: [
        { name: n1.sourceString, type: t1.toAST() },
        { name: n2.sourceString, type: t2.toAST() },
      ],
      resultType: rt.toAST(),
    };
  },
  OpDefHeader_outfix(open, _o, n, _c, t, _p, close, _c2, rt) {
    return {
      kind: 'opDef', fixity: 'outfix', op: open.sourceString, closeOp: close.sourceString,
      params: [{ name: n.sourceString, type: t.toAST() }],
      resultType: rt.toAST(),
    };
  },
  OpDefHeader_prefix(op, _o, n, _c, t, _p, _c2, rt) {
    return {
      kind: 'opDef', fixity: 'prefix', op: op.sourceString, closeOp: null,
      params: [{ name: n.sourceString, type: t.toAST() }],
      resultType: rt.toAST(),
    };
  },
  OpBody(_ind, expr, _eol, _ded) {
    return expr.toAST();
  },

  // --- kernels ---
  Kernel(name, sig, _eol, body) {
    const s = sig.toAST();
    const b = body.toAST();
    return { kind: 'kernel', name: name.sourceString, params: s.params, type: s.type, ...b };
  },
  KernelSig_plain(_c, ktype) {
    return { params: null, type: ktype.toAST() };
  },
  KernelBody(_ind, pre, forAlls, post, _ded) {
    return { prologue: iter(pre), forAlls: iter(forAlls), epilogue: iter(post) };
  },
  ForAll(_fa, pat, consOpt, withOpt, _eol, blockOpt) {
    const cons = optional<{ pat: unknown; key: string | null } | 'end'>(consOpt);
    return {
      kind: 'forAll',
      pattern: pat.toAST(),
      cons: cons === null ? null : cons === 'end' ? 'end' : cons.pat,
      consKey: cons !== null && cons !== 'end' ? cons.key : null,
      scan: optional(withOpt),
      body: optional(blockOpt) ?? [],
    };
  },
  ConsPart_pat(_c, pat, segByOpt) {
    return { pat: pat.toAST(), key: optional(segByOpt) };
  },
  ConsPart_end(_c, _empty) {
    return 'end';
  },
  SegBy(_by, _at, key) {
    return key.sourceString;
  },
  WithClause(_with, name, _eq, op, _ob, expr, _cb, _by, _at, key) {
    return {
      name: name.sourceString,
      op: op.sourceString,
      expr: expr.toAST(),
      key: key.sourceString,
    };
  },
  Block(_ind, stmts, _ded) {
    return iter(stmts);
  },

  // --- statements ---
  OutStmt(parts, _eol) {
    return { kind: 'out', exprs: iter(parts) } satisfies ast.OutStmt;
  },
  OutPart(_a, expr) {
    return expr.toAST();
  },
  InStmt(parts, _eol) {
    return { kind: 'in', exprs: iter(parts) } satisfies ast.InStmt;
  },
  InPart(_a, expr) {
    return expr.toAST();
  },
  IfStmt(_if, cond, _eol, block, elseOpt) {
    return { kind: 'if', cond: cond.toAST(), then: block.toAST(), else: optional(elseOpt) };
  },
  ElsePart_elseif(_else, ifStmt) {
    return [ifStmt.toAST()];
  },
  ElsePart_else(_else, _eol, block) {
    return block.toAST();
  },
  Forwarding(_a, pipeline, _eol) {
    return { kind: 'forward', pipeline: pipeline.toAST() } satisfies ast.Forwarding;
  },
  TypedDecl(name, _c, type, _eq, value, _eol) {
    return { kind: 'decl', name: name.sourceString, type: type.toAST(), value: value.toAST() };
  },
  Decl(name, _eq, value, _eol) {
    const id = name.sourceString;
    if (id.endsWith("'")) {
      return { kind: 'assign', name: id.slice(0, -1), value: value.toAST() } satisfies ast.Assign;
    }
    return { kind: 'decl', name: id, type: null, value: value.toAST() } satisfies ast.Decl;
  },
  PatAssign(pat, _eq, value, _eol) {
    return { kind: 'patAssign', pattern: pat.toAST(), value: value.toAST() };
  },

  Pat_tuple(_o, pats, _c) {
    return { kind: 'tuplePat', elements: list(pats) };
  },
  Pat_wildcard(_u) {
    return { kind: 'wildcardPat' };
  },
  Pat_var(name) {
    return { kind: 'varPat', name: name.sourceString };
  },

  // --- pipelines ---
  Pipeline(elems) {
    return list(elems);
  },
  KI_app(name, _o, args, _c) {
    return { kind: 'kernelApp', name: name.sourceString, args: list(args) };
  },
  KI_identity(_o, _a, _c) {
    return { kind: 'identityPipeline' };
  },
  KI_ref(name) {
    return { kind: 'kernelRef', name: name.sourceString };
  },
  GroupByStage(_kw, stableOpt, _o, keys, _c) {
    return { kind: 'groupBy', keys: list(keys), stable: stableOpt.numChildren > 0 };
  },
  ReduceByStage(_kw, _o, keys, _semi, fields, _c) {
    return { kind: 'reduceBy', keys: list(keys), fields: list(fields) };
  },
  FieldReduce(name, _op, op) {
    return { name: name.sourceString, op: op.sourceString };
  },
  KeyRef(_at, name) {
    return name.sourceString;
  },
  MultiPipeline(first, _arrows, rest) {
    return { kind: 'pipelineArg', elements: [first.toAST(), ...iter(rest)] };
  },
  KIApp(name, _o, args, _c) {
    return { kind: 'kernelApp', name: name.sourceString, args: list(args) };
  },
  IdentityKI(_o, _a, _c) {
    return { kind: 'identityPipeline' };
  },

  // --- expressions ---
  CondExpr_cond(value, _if, cond, _comma, rest) {
    const restAst = rest.toAST();
    const first = { value: value.toAST(), cond: cond.toAST() };
    if (restAst.kind === 'cond') {
      return { ...restAst, cases: [first, ...restAst.cases] };
    }
    return { kind: 'cond', cases: [first], otherwise: restAst } satisfies ast.CondExpr;
  },
  OrExpr_bin: binOp,
  AndExpr_bin: binOp,
  EqExpr_bin: binOp,
  RelExpr_bin: binOp,
  AddExpr_bin: binOp,
  AddExpr_userbin: binOp,
  MulExpr_bin: binOp,
  PostExpr_field(obj, _dot, field) {
    return { kind: 'field', object: obj.toAST(), field: field.sourceString };
  },
  PostExpr_typed(expr, _c, type) {
    return { kind: 'typed', expr: expr.toAST(), type: type.toAST() };
  },
  UnExpr_sqrt: (_op, e) => unOp('√_', e),
  UnExpr_neg: (_op, e) => unOp('-_', e),
  UnExpr_not: (_op, e) => unOp('¬_', e),
  UnExpr_userpre: (op, e) => unOp(opKey('prefix', op.sourceString), e),
  PrimExpr_cond(_o, cond, _c) {
    return cond.toAST();
  },
  PrimExpr_floor: (_o, e, _c) => unOp('⌊_⌋', e),
  PrimExpr_ceil: (_o, e, _c) => unOp('⌈_⌉', e),
  PrimExpr_parenOrTuple(_o, exprs, _c) {
    const elements = list<ast.Expr>(exprs);
    return elements.length === 1 ? elements[0] : { kind: 'tuple', elements };
  },
  PrimExpr_brackTuple(_o, exprs, _c) {
    return { kind: 'tuple', elements: list(exprs) };
  },
  PrimExpr_offset(_at, name) {
    return { kind: 'offset', field: name.sourceString };
  },
  PrimExpr_num(n) {
    return { kind: 'num', value: parseFloat(n.sourceString) };
  },
  PrimExpr_var(name) {
    return { kind: 'var', name: name.sourceString };
  },
};
