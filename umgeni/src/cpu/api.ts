// A compiled library as the host sees it. Generated code registers a
// factory per process (its Op over flattened parameters); this module lets
// the host call them by parameter name, read and build tokens by field
// name, define the processes the Nile declared by signature alone, and run
// a process over a batch.

import type { ParamSig, TokenLayout } from '../ir.js';
import { run, type Op, type Token } from './op.js';

// A process's parameters, flat in declaration order (as generated code
// passes them), or named as its Nile signature names them: a Real is a
// number, a record (Point, Matrix, Color…) its fields as an array.
export type Params = number[] | { [name: string]: number | readonly NestedNumbers[] };
type NestedNumbers = number | readonly NestedNumbers[];

// What generated code registers under a process's name: its Op, over its
// flattened parameters (or named ones, after nameParams).
export type Factory = (P?: Params) => Op;

// Let each factory in a registry take its parameters by name too, checked
// against the process's signature: every name present, no others, each the
// right size. Flat arrays pass straight through.
export function nameParams(R: Record<string, Factory>, signatures: Record<string, ParamSig[]>): void {
  for (const [process, sig] of Object.entries(signatures)) {
    const factory = R[process];
    if (!factory || sig.length === 0) continue;
    R[process] = (P?: Params) =>
      factory(P === undefined || Array.isArray(P) ? (P as number[] | undefined) : flattenNamed(`${process} takes`, sig, P));
  }
}

// Named values, flattened in the order `fields` gives, each checked for size.
// Hot when building tokens, so numbers and flat arrays are written directly;
// only a nested array is flattened.
function flattenNamed(what: string, fields: ParamSig[], named: Exclude<Params, number[]>): number[] {
  const expected = () => `${what} ${fields.map((p) => `${p.name} (${p.width})`).join(', ')}`;
  const out: number[] = [];
  for (const p of fields) {
    const v = named[p.name];
    if (v === undefined) throw new Error(`missing '${p.name}': ${expected()}`);
    const start = out.length;
    if (typeof v === 'number') out.push(v);
    else if (v.some(Array.isArray)) out.push(...((v as unknown[]).flat(Infinity as 1) as number[]));
    else for (let i = 0; i < v.length; i++) out.push(v[i] as number);
    if (out.length - start !== p.width) throw new Error(`'${p.name}' needs ${p.width} number(s), got ${out.length - start}: ${expected()}`);
  }
  for (const k in named) {
    if (!fields.some((p) => p.name === k)) throw new Error(`unknown '${k}': ${expected()}`);
  }
  return out;
}

// --- what a registry carries beside its factories ----------------------------

// Generated code describes its library on the registry record under symbols:
// the host-process slots, the token layouts and (with countOps) the counter.
const meta = <T,>(R: object, sym: symbol): T | undefined => (R as Record<symbol, T | undefined>)[sym];
function describe<T>(R: object, sym: symbol, value: T): T {
  Object.defineProperty(R, sym, { value });
  return value;
}

// --- processes the host supplies ---------------------------------------------

// A process declared in Nile by its signature alone (`ReadImage :: (img :
// Real) : Point >> Color`) is the host's to define: generated code holds a place
// for it, and the host fills the place with a factory taking the flattened
// parameters (or, through the api, by name).
const HOSTS = Symbol.for('midlands.nile.hosts');
type Slot = { factory: ((P: number[]) => Op) | null };

// The place for a host process: nameParams wraps it like any factory, so
// by the time a call reaches the slot its parameters are flat (or absent).
export function hostProcess(R: object, name: string): Factory {
  const hosts = meta<Map<string, Slot>>(R, HOSTS) ?? describe(R, HOSTS, new Map<string, Slot>());
  const slot: Slot = { factory: null };
  hosts.set(name, slot);
  return (P) => {
    if (!slot.factory) throw new Error(`'${name}' is a process the host supplies, and this host has not provided it (nile.provide)`);
    return slot.factory(Array.isArray(P) ? P : []);
  };
}

function provide(R: object, name: string, factory: (P: number[]) => Op): void {
  const slot = meta<Map<string, Slot>>(R, HOSTS)?.get(name);
  if (!slot) throw new Error(`'${name}' is not a process the host supplies (declared as 'Name :: (params) : In >> Out')`);
  slot.factory = factory;
}

// --- tokens by field name ----------------------------------------------------

// The library's token layouts (set by generated code).
const TYPES = Symbol.for('midlands.nile.types');
export const describeTypes = (R: object, types: Record<string, TokenLayout>): void => void describe(R, TYPES, types);

// The counter of executed IR operations, when compiled with countOps (set
// by generated code, read by benchmarks).
const OPS = Symbol.for('midlands.nile.ops');
export const describeOps = (R: object, count: () => number): void => void describe(R, OPS, count);
export const opsCounter = (R: object): (() => number) | undefined => meta(R, OPS);

// A named record type, for reading and building its tokens by field name.
// Look offsets up once (at) and index tokens with them in hot loops; get and
// make are for everywhere else.
export interface TokenType {
  name: string;
  width: number;
  /** A field's offset in the flattened token ('n', or dotted: 'C.r'). */
  at(path: string): number;
  /** A field's value: a number, or the slice of a record field. */
  get(t: Token, path: string): number | number[];
  /** A token from its top-level fields, each checked for size. */
  make(fields: Exclude<Params, number[]>): Token;
}

function tokenType(name: string, layout: TokenLayout): TokenType {
  const field = (path: string) => {
    const f = layout.fields[path];
    if (!f) throw new Error(`'${path}' is not a field of ${name}: ${Object.keys(layout.fields).join(', ')}`);
    return f;
  };
  const top = Object.entries(layout.fields)
    .filter(([path]) => !path.includes('.'))
    .sort((a, b) => a[1].at - b[1].at)
    .map(([path, f]) => ({ name: path, width: f.width }));
  return {
    name,
    width: layout.width,
    at: (path) => field(path).at,
    get: (t, path) => {
      const f = field(path);
      return f.width === 1 ? t[f.at] : t.slice(f.at, f.at + f.width);
    },
    make: (fields) => flattenNamed(`${name} has`, top, fields),
  };
}

// --- a library's API --------------------------------------------------------

// An Op that can also simply run: push every token, end, return what it emitted.
export interface RunnableOp extends Op {
  run(tokens: Token[]): Token[];
}
export type ProcessFn = (params?: Params) => RunnableOp;

// A compiled library as the host sees it: each process by name, taking its
// parameters by name, and each named record type for reading and building
// tokens. (Nile process and type names start with a capital, so `types`
// cannot collide.)
export type Api = { readonly [process: string]: ProcessFn } & {
  readonly types: { readonly [name: string]: TokenType };
  /** Define a process the Nile declared by signature alone, as an Op over
   *  its flattened parameters. */
  readonly provide: (name: string, factory: (P: number[]) => Op) => void;
};

export function api(registry: Record<string, Factory>): Api {
  const out: Record<string, unknown> = {};
  for (const [name, factory] of Object.entries(registry)) {
    out[name] = (P?: Params) => {
      const op = factory(P) as RunnableOp;
      op.run = (tokens) => run(op, tokens);
      return op;
    };
  }
  const layouts = meta<Record<string, TokenLayout>>(registry, TYPES) ?? {};
  out.types = Object.fromEntries(Object.entries(layouts).map(([name, layout]) => [name, tokenType(name, layout)]));
  out.provide = (name: string, factory: (P: number[]) => Op) => provide(registry, name, factory);
  return out as Api;
}

