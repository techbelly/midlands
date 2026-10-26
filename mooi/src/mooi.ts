// Mooi: a small equational language for writing compilers' semantics.
// Definitions are clauses matched in order (patterns name AST/IR nodes
// directly: `binOp{op, left, right}`), with optional guards; expressions are
// a little lambda calculus with let, lists, records and sequencing. Functions
// are curried by arity, so host primitives (plain JS functions) and Mooi
// definitions apply alike.

import * as ohm from 'ohm-js';
import { mooiGrammarSource } from './source.js';

const grammar = ohm.grammar(mooiGrammarSource);

// --- syntax (plain data) ---
type Pat =
  | { p: 'node'; name: string; fields: [string, Pat][] }
  | { p: 'list'; items: Pat[]; rest: string | null }
  | { p: 'wild' }
  | { p: 'lit'; value: unknown }
  | { p: 'var'; name: string };
type Expr =
  | { e: 'lam'; pats: Pat[]; body: Expr }
  | { e: 'let'; binds: [Pat, Expr][]; body: Expr }
  | { e: 'if'; c: Expr; t: Expr; f: Expr }
  | { e: 'bin'; op: string; a: Expr; b: Expr }
  | { e: 'app'; f: Expr; x: Expr }
  | { e: 'field'; x: Expr; name: string }
  | { e: 'list'; items: Expr[] }
  | { e: 'record'; kind: string | null; fields: [string, Expr][] }
  | { e: 'lit'; value: unknown }
  | { e: 'var'; name: string };
interface Clause {
  pats: Pat[];
  guard: Expr | null;
  body: Expr;
}

const semantics = grammar.createSemantics().addOperation('ast', {
  Program: (_lead, defs, _sep) => defs.asIteration().children.map((d: ohm.Node) => d.ast()),
  Def: (name, pats, guard, _eq, body) => ({
    name: name.sourceString,
    clause: { pats: pats.children.map((p: ohm.Node) => p.ast()), guard: guard.children[0]?.ast() ?? null, body: body.ast() },
  }),
  Guard: (_bar, e) => e.ast(),
  Pat_node: (open, fields, _c) => ({ p: 'node', name: open.sourceString.slice(0, -1), fields: fields.asIteration().children.map((f: ohm.Node) => f.ast()) }),
  Pat_nil: (_o, _c) => ({ p: 'list', items: [], rest: null }),
  Pat_cons: (_o, items, _comma, _dots, rest, _c) => ({ p: 'list', items: items.asIteration().children.map((x: ohm.Node) => x.ast()), rest: rest.sourceString }),
  Pat_list: (_o, items, _c) => ({ p: 'list', items: items.asIteration().children.map((x: ohm.Node) => x.ast()), rest: null }),
  Pat_wild: (_u) => ({ p: 'wild' }),
  Pat_num: (n) => ({ p: 'lit', value: Number(n.sourceString) }),
  Pat_str: (s) => ({ p: 'lit', value: s.sourceString.slice(1, -1) }),
  Pat_var: (n) => (n.sourceString === 'null' ? { p: 'lit', value: null } : { p: 'var', name: n.sourceString }),
  Pat_paren: (_o, p, _c) => p.ast(),
  FieldPat_rename: (name, _c, p) => [name.sourceString, p.ast()],
  FieldPat_same: (name) => [name.sourceString, { p: 'var', name: name.sourceString }],
  Expr_lam: (_bs, pats, _arrow, body) => ({ e: 'lam', pats: pats.children.map((p: ohm.Node) => p.ast()), body: body.ast() }),
  Expr_let: (_let, binds, _in, body) => ({ e: 'let', binds: binds.asIteration().children.map((b: ohm.Node) => b.ast()), body: body.ast() }),
  Expr_if: (_if, c, _then, t, _else, f) => ({ e: 'if', c: c.ast(), t: t.ast(), f: f.ast() }),
  Binding: (p, _eq, x) => [p.ast(), x.ast()],
  Seq_seq: (a, _op, b) => ({ e: 'bin', op: ';', a: a.ast(), b: b.ast() }),
  Coal_coal: (a, _op, b) => ({ e: 'bin', op: '??', a: a.ast(), b: b.ast() }),
  Or_or: (a, _op, b) => ({ e: 'bin', op: '||', a: a.ast(), b: b.ast() }),
  And_and: (a, _op, b) => ({ e: 'bin', op: '&&', a: a.ast(), b: b.ast() }),
  Cmp_cmp: (a, op, b) => ({ e: 'bin', op: op.sourceString, a: a.ast(), b: b.ast() }),
  Cat_cat: (a, _op, b) => ({ e: 'bin', op: '++', a: a.ast(), b: b.ast() }),
  Add_add: (a, op, b) => ({ e: 'bin', op: op.sourceString, a: a.ast(), b: b.ast() }),
  Mul_mul: (a, op, b) => ({ e: 'bin', op: op.sourceString, a: a.ast(), b: b.ast() }),
  App_app: (f, x) => ({ e: 'app', f: f.ast(), x: x.ast() }),
  Post_field: (x, _dot, name) => ({ e: 'field', x: x.ast(), name: name.sourceString }),
  Atom_paren: (_o, x, _c) => x.ast(),
  Atom_list: (_o, items, _c) => ({ e: 'list', items: items.asIteration().children.map((x: ohm.Node) => x.ast()) }),
  Atom_node: (open, fields, _c) => ({ e: 'record', kind: open.sourceString.slice(0, -1), fields: fields.asIteration().children.map((f: ohm.Node) => f.ast()) }),
  Atom_record: (_o, fields, _c) => ({ e: 'record', kind: null, fields: fields.asIteration().children.map((f: ohm.Node) => f.ast()) }),
  Atom_num: (n) => ({ e: 'lit', value: Number(n.sourceString) }),
  Atom_str: (s) => ({ e: 'lit', value: s.sourceString.slice(1, -1) }),
  Atom_var: (n) => ({ e: 'var', name: n.sourceString }),
  FieldInit_spread: (_dots, x) => ['...', x.ast()],
  FieldInit_field: (name, _c, x) => [name.sourceString, x.ast()],
});

// Layout: a line starting at column 0 starts a definition.
const layout = (src: string) =>
  src.split('\n').map((l, i) => (i > 0 && /^[^\s-]/.test(l) ? `¶ ${l}` : l)).join('\n');

// --- evaluation ---

// Scopes chain to their parent instead of copying it.
class Env {
  private vars = new Map<string, unknown>();
  constructor(private parent: Env | null = null) {}
  has(n: string): boolean {
    return this.vars.has(n) || (this.parent?.has(n) ?? false);
  }
  get(n: string): unknown {
    return this.vars.has(n) ? this.vars.get(n) : this.parent?.get(n);
  }
  set(n: string, v: unknown): void {
    this.vars.set(n, v);
  }
}
const NO = Symbol('no match');

// Mooi has one missing value: JS null and undefined are the same to it.
const same = (a: unknown, b: unknown) => a === b || (a == null && b == null);
// A node's tag: `kind` in Nile's syntax trees, `k` in umgeni's values and IR.
const tagOf = (v: object) => (v as { kind?: string }).kind ?? (v as { k?: string }).k;

// Apply a function value to one argument. Functions are curried by arity (a
// JS function's length), host and Mooi alike: applied short of its arity, a
// function gives back a function of the arguments still owed.
export function app(f: unknown, x: unknown): unknown {
  if (typeof f !== 'function') throw new Error(`Mooi: applying a non-function (${describe(f)})`);
  if (f.length <= 1) return f(x); // a zero-arity function (a cell's get) ignores x
  return withArity(f.length - 1, (...rest: unknown[]) => f(x, ...rest));
}

function withArity<F extends (...a: unknown[]) => unknown>(n: number, f: F): F {
  Object.defineProperty(f, 'length', { value: n });
  return f;
}

function match(p: Pat, v: unknown, env: Env): boolean {
  switch (p.p) {
    case 'wild': return true;
    case 'var': env.set(p.name, v); return true;
    case 'lit': return same(v, p.value);
    case 'node': {
      if (v === null || typeof v !== 'object') return false;
      const o = v as Record<string, unknown>;
      if (tagOf(o) !== p.name) return false;
      return p.fields.every(([f, sub]) => match(sub, o[f], env));
    }
    case 'list': {
      if (!Array.isArray(v)) return false;
      if (p.rest === null ? v.length !== p.items.length : v.length < p.items.length) return false;
      if (!p.items.every((sub, i) => match(sub, v[i], env))) return false;
      if (p.rest !== null) env.set(p.rest, v.slice(p.items.length));
      return true;
    }
  }
}

// Parsing is the expensive part; a source is parsed once and its
// definitions reused for every instantiation.
const parsed = new Map<string, { name: string; clause: Clause }[]>();
function parse(src: string) {
  let defs = parsed.get(src);
  if (!defs) {
    const m = grammar.match(layout(src));
    if (m.failed()) throw new Error(`Mooi: ${m.message}`);
    defs = semantics(m).ast() as { name: string; clause: Clause }[];
    parsed.set(src, defs);
  }
  return defs;
}

export function load(src: string, host: Record<string, unknown>): Record<string, unknown> {
  const defs = parse(src);
  const clauses = new Map<string, Clause[]>();
  for (const d of defs) clauses.set(d.name, [...(clauses.get(d.name) ?? []), d.clause]);
  const globals: Record<string, unknown> = { ...host };

  const lookup = (name: string, env: Env): unknown => {
    if (env.has(name)) return env.get(name);
    if (name in globals) return globals[name];
    throw new Error(`Mooi: unbound '${name}'`);
  };

  const ev = (x: Expr, env: Env): unknown => {
    switch (x.e) {
      case 'lit': return x.value;
      case 'var': return lookup(x.name, env);
      case 'field': {
        const o = ev(x.x, env) as Record<string, unknown> | null;
        if (o === null || o === undefined) throw new Error(`Mooi: '.${x.name}' of ${o}`);
        return o[x.name];
      }
      case 'list': return x.items.map((i) => ev(i, env));
      case 'record': {
        const o: Record<string, unknown> = x.kind ? { kind: x.kind } : {};
        for (const [f, v] of x.fields) {
          if (f === '...') Object.assign(o, ev(v, env));
          else o[f] = ev(v, env);
        }
        return o;
      }
      case 'app': return app(ev(x.f, env), ev(x.x, env));
      case 'if': return ev(x.c, env) ? ev(x.t, env) : ev(x.f, env);
      case 'let': {
        const inner = new Env(env);
        for (const [p, v] of x.binds) if (!match(p, ev(v, inner), inner)) throw new Error('Mooi: let pattern did not match');
        return ev(x.body, inner);
      }
      case 'lam':
        return withArity(x.pats.length, (...args: unknown[]) => {
          const inner = new Env(env);
          x.pats.forEach((p, i) => {
            if (!match(p, args[i], inner)) throw new Error('Mooi: lambda pattern did not match');
          });
          return ev(x.body, inner);
        });
      case 'bin': {
        if (x.op === ';') { ev(x.a, env); return ev(x.b, env); }
        const a = ev(x.a, env);
        if (x.op === '??') return a ?? ev(x.b, env);
        if (x.op === '||') return a || ev(x.b, env);
        if (x.op === '&&') return a && ev(x.b, env);
        const b = ev(x.b, env) as never;
        switch (x.op) {
          case '==': return same(a, b);
          case '!=': return !same(a, b);
          case '<': return (a as number) < b;
          case '>': return (a as number) > b;
          case '<=': return (a as number) <= b;
          case '>=': return (a as number) >= b;
          case '++': return typeof a === 'string' ? a + b : [...(a as unknown[]), ...(b as unknown[])];
          case '+': return (a as number) + b;
          case '-': return (a as number) - b;
          case '*': return (a as number) * b;
          case '/': return (a as number) / b;
        }
        throw new Error(`Mooi: operator ${x.op}`);
      }
    }
  };

  for (const [name, cs] of clauses) {
    const arity = cs[0].pats.length;
    if (cs.some((c) => c.pats.length !== arity)) throw new Error(`Mooi: clauses of '${name}' differ in arity`);
    const run = (args: unknown[]): unknown => {
      for (const c of cs) {
        const env = new Env();
        if (!c.pats.every((p, i) => match(p, args[i], env))) continue;
        if (c.guard && !ev(c.guard, env)) continue;
        return ev(c.body, env);
      }
      throw new Error(`Mooi: no clause of '${name}' matches (${args.map((a) => describe(a)).join(', ')})`);
    };
    if (arity === 0) {
      let cached: unknown = NO;
      Object.defineProperty(globals, name, { get: () => (cached === NO ? (cached = run([])) : cached), enumerable: true });
    } else {
      globals[name] = withArity(arity, (...args: unknown[]) => run(args));
    }
  }
  return globals;
}

const describe = (v: unknown) =>
  v && typeof v === 'object' ? (tagOf(v) ?? (Array.isArray(v) ? `[${v.length}]` : '{…}')) : String(v);
