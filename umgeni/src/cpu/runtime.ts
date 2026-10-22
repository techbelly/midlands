// The streaming runtime. Ported from chari's runtime (which validated the
// model against the tiger demo), with one representational change: a token is
// always a flat array of numbers — records are scalarized by elaboration, so
// a Bezier flows through as 6 numbers. This keeps the runtime shape-blind and
// leaves the road open to typed-array batching.
//
// Kernels themselves are generated code (js.ts: every kernel runs as a
// segment, with feedback as a LIFO worklist — recursive subdivision runs
// depth-first as iteration, not JS recursion). This module supplies the
// builtin stages, composition, and the boundary to the host.

export type Token = number[];
export type Emit = (t: Token) => void;

// A process's parameters, flat in declaration order (as generated code
// passes them), or named as its Nile signature names them: a Real is a
// number, a record (Point, Matrix, Color…) its fields as an array.
export type Params = number[] | { [name: string]: number | readonly NestedNumbers[] };
type NestedNumbers = number | readonly NestedNumbers[];
export type Feed = (t: Token) => void;

export interface Op {
  push(t: Token): void;
  end(): void;
  setEmit(e: Emit): void;
  // Optional batch path, equivalent to pushing each token in order: a
  // barrier that emits its whole buffer at once hands it over in one call
  // (a wasm segment then loops inside wasm instead of crossing per token).
  pushAll?(ts: Token[]): void;
  setEmitAll?(e: (ts: Token[]) => void): void;
}

// Let each factory in a registry take its parameters by name too, checked
// against the process's signature: every name present, no others, each the
// right size. Flat arrays pass straight through.
export function nameParams(
  R: Record<string, (P?: number[]) => Op>,
  signatures: Record<string, { name: string; width: number }[]>,
): void {
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
function flattenNamed(what: string, fields: { name: string; width: number }[], named: Exclude<Params, number[]>): number[] {
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

// --- tokens by field name ----------------------------------------------------

export interface TokenLayout {
  width: number;
  fields: Record<string, { at: number; width: number }>;
}

// Where a registry keeps its program's token layouts (set by generated code).
export const TYPES = Symbol.for('midlands.nile.types');

export function describeTypes(R: object, types: Record<string, TokenLayout>): void {
  Object.defineProperty(R, TYPES, { value: types });
}

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

export function tokenType(registry: object, name: string): TokenType {
  const types = (registry as { [TYPES]?: Record<string, TokenLayout> })[TYPES];
  if (!types) throw new Error('this registry carries no token types (compiled before they existed?)');
  const layout = types[name];
  if (!layout) throw new Error(`no record type named '${name}' (known: ${Object.keys(types).join(', ')})`);
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

// --- a program's API --------------------------------------------------------

// An Op that can also simply run: push every token, end, return what it emitted.
export interface RunnableOp extends Op {
  run(tokens: Token[]): Token[];
}
export type ProcessFn = (params?: Params) => RunnableOp;

// A compiled program as the host sees it: each process by name, taking its
// parameters by name, and each named record type for reading and building
// tokens. (Nile process and type names start with a capital, so `types`
// cannot collide.)
export type Api = { readonly [process: string]: ProcessFn } & { readonly types: { readonly [name: string]: TokenType } };

export function api(registry: Map<string, (P?: Params) => Op> | Record<string, (P?: Params) => Op>): Api {
  const entries = registry instanceof Map ? [...registry] : Object.entries(registry);
  const out: Record<string, unknown> = {};
  for (const [name, factory] of entries) {
    out[name] = (P?: Params) => {
      const op = factory(P) as RunnableOp;
      op.run = (tokens) => {
        const emitted: Token[] = [];
        op.setEmit((t) => emitted.push(t));
        for (const t of tokens) op.push(t);
        op.end();
        return emitted;
      };
      return op;
    };
  }
  const layouts = (registry as { [TYPES]?: Record<string, TokenLayout> })[TYPES] ?? {};
  out.types = Object.fromEntries(Object.keys(layouts).map((name) => [name, tokenType(registry, name)]));
  return out as Api;
}

// A buffering sort stage: collects every token, emits stably sorted by the
// given flattened field offset on end(). It stalls the streaming overlap but
// composes through the same end() propagation as any other op.
//
// The sort itself exploits the keys rasterization produces — pixel
// coordinates, i.e. half-integers in a bounded range: tokens are bucketed by
// the integer part of the key (O(n), stable by construction), and a bucket
// only pays for a comparison sort if it actually contains distinct keys.
// For scanline data every bucket is single-keyed, so no comparisons happen
// at all. Keys that don't fit (wide range, non-finite) fall back to a plain
// stable sort, so the result is always exactly a stable sort by key.
export function sortTokens(buffer: Token[], keyIndex: number): Token[] {
  const n = buffer.length;
  if (n < 2) return buffer;

  let min = Infinity;
  let max = -Infinity;
  let finite = true;
  for (const t of buffer) {
    const v = t[keyIndex];
    if (!Number.isFinite(v)) {
      finite = false;
      break;
    }
    if (v < min) min = v;
    if (v > max) max = v;
  }

  // Bucket count must stay O(n) for this to be a win.
  if (!finite || max - min > 4 * n + 1024) {
    return buffer.sort((a, b) => a[keyIndex] - b[keyIndex]); // native sort is stable
  }

  const base = Math.floor(min);
  const buckets: Token[][] = new Array(Math.floor(max) - base + 1);
  const mixed: boolean[] = new Array(buckets.length);
  for (const t of buffer) {
    const i = Math.floor(t[keyIndex]) - base;
    const b = buckets[i];
    if (b === undefined) {
      buckets[i] = [t];
    } else {
      if (t[keyIndex] !== b[0][keyIndex]) mixed[i] = true;
      b.push(t);
    }
  }
  const out: Token[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (b === undefined) continue;
    if (mixed[i]) b.sort((a, c) => a[keyIndex] - c[keyIndex]);
    for (const t of b) out.push(t);
  }
  return out;
}

// A barrier is a function on finite streams: buffer every token, apply f at
// end of stream, emit the result (whole, to a stage that takes batches).
export function barrier(f: (ts: Token[]) => Token[]): Op {
  let buffer: Token[] = [];
  let emit: Emit = () => {};
  let emitAll: ((ts: Token[]) => void) | null = null;
  return {
    push(t) {
      buffer.push(t);
    },
    end() {
      const out = f(buffer);
      buffer = [];
      if (emitAll) emitAll(out);
      else for (const t of out) emit(t);
    },
    setEmit(e) {
      emit = e;
    },
    setEmitAll(e) {
      emitAll = e;
    },
  };
}

export const sortBy = (keyIndex: number): Op => barrier((ts) => sortTokens(ts, keyIndex));

// GroupBy: buffer, order by keys (major first), emit on end(). The language
// contract is key order only; this implementation happens to be stable
// (successive stable sorts, minor key first), which is a valid instance.
export const groupBy = (keyIndexes: number[], _stable: boolean): Op =>
  barrier((ts) => keyIndexes.reduceRight((acc, k) => sortTokens(acc, k), ts));

// ReduceBy: merge adjacent same-key runs (the upstream GroupBy guarantees
// grouping) with per-field combining functions; other fields keep the first
// token's values.
export function reduceBy(
  keyIndexes: number[],
  fields: { index: number; fn: (a: number, b: number) => number }[],
): Op {
  let cur: Token | null = null;
  let emit: Emit = () => {};
  return {
    push(t) {
      if (cur !== null && keyIndexes.every((k) => cur![k] === t[k])) {
        for (const f of fields) cur[f.index] = f.fn(cur[f.index], t[f.index]);
        return;
      }
      if (cur !== null) emit(cur);
      cur = t.slice();
    },
    end() {
      if (cur !== null) emit(cur);
      cur = null;
    },
    setEmit(e) {
      emit = e;
    },
  };
}

export const reverse = (): Op => barrier((ts) => ts.reverse());

// DupCat: the first branch streams; the second replays the buffered input
// once the first has finished.
export function dupCat(a: Op, b: Op): Op {
  const buffer: Token[] = [];
  return {
    push(t) {
      buffer.push(t);
      a.push(t);
    },
    end() {
      a.end();
      for (const t of buffer) b.push(t);
      b.end();
    },
    setEmit(e) {
      a.setEmit(e);
      b.setEmit(e);
    },
  };
}

// DupZip: both branches stream; each output of the first pairs with the
// matching output of the second, emitted as soon as both exist.
export function dupZip(a: Op, b: Op): Op {
  const qa: Token[] = [];
  const qb: Token[] = [];
  let emit: Emit = () => {};
  a.setEmit((t) => void qa.push(t));
  b.setEmit((t) => void qb.push(t));
  const pair = () => {
    const n = Math.min(qa.length, qb.length);
    for (let i = 0; i < n; i++) emit([...qa[i], ...qb[i]]);
    qa.splice(0, n);
    qb.splice(0, n);
  };
  return {
    push(t) {
      a.push(t);
      b.push(t);
      pair();
    },
    end() {
      a.end();
      b.end();
      pair();
    },
    setEmit(e) {
      emit = e;
    },
  };
}

// A fused segment compiled to WebAssembly (wasm.ts). Each op instance
// gets its own wasm instance (its own state); push() calls straight into
// stage 0 with the token's values, and whatever reached the output buffer is
// emitted when the call returns (or mid-call, if the buffer fills).
export const wasmModule = (bytes: number[]): WebAssembly.Module => new WebAssembly.Module(Uint8Array.from(bytes));

export function wasmSegment(module: WebAssembly.Module, layout: { outBase: number; outWidth: number; inBase: number; inWidth: number; inTokens: number }, params: number[]): Op {
  const { outBase, outWidth, inBase, inWidth, inTokens } = layout;
  let emit: Emit = () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let x: any = null;
  let mem: Float64Array = new Float64Array(0); // memory never grows: one view
  const base = outBase / 8;
  // push/pushAll/end return the output pointer; drain() (also called by wasm
  // when the buffer fills) emits everything below it and resets it.
  const drain = (stop: number = x.out.value) => {
    for (let p = base; p < stop / 8; p += outWidth) {
      const t: number[] = [];
      for (let i = 0; i < outWidth; i++) t.push(mem[p + i]);
      emit(t);
    }
    x.out.value = outBase;
  };
  x = new WebAssembly.Instance(module, { env: { drain: () => drain() } }).exports;
  mem = new Float64Array(x.memory.buffer);
  mem.set(params, 0);
  x.init();
  const call: (...t: number[]) => number = x.push;
  const done = (stop: number) => {
    if (stop !== outBase) drain(stop);
  };
  return {
    push: (t) => done(call(...t)),
    pushAll(ts) {
      // Copy a chunk of tokens into linear memory; wasm loops over them.
      for (let k = 0; k < ts.length; k += inTokens) {
        const m = Math.min(inTokens, ts.length - k);
        let o = inBase / 8;
        for (let j = 0; j < m; j++) {
          const t = ts[k + j];
          for (let i = 0; i < inWidth; i++) mem[o++] = t[i];
        }
        done(x.pushAll(m));
      }
    },
    end: () => done(x.end()),
    setEmit(e) {
      emit = e;
    },
  };
}

export function identity(): Op {
  let emit: Emit = () => {};
  return {
    push: (t) => emit(t),
    end: () => {},
    setEmit: (e) => {
      emit = e;
    },
  };
}

// Compose `a → b`: a's output becomes b's input; end() drains a then b.
export function compose(a: Op, b: Op): Op {
  a.setEmit((t) => b.push(t));
  if (a.setEmitAll && b.pushAll) a.setEmitAll((ts) => b.pushAll!(ts));
  return {
    push: (t) => a.push(t),
    ...(a.pushAll ? { pushAll: (ts: Token[]) => a.pushAll!(ts) } : {}),
    end: () => {
      a.end();
      b.end();
    },
    setEmit: (e) => b.setEmit(e),
    ...(b.setEmitAll ? { setEmitAll: (e: (ts: Token[]) => void) => b.setEmitAll!(e) } : {}),
  };
}

export function pipeline(ops: Op[]): Op {
  if (ops.length === 0) return identity();
  return ops.reduce((acc, op) => compose(acc, op));
}

// The boundary surface: push(token) returns exactly the outputs that token
// produced; end() returns whatever the flush bodies emit.
export interface Streamer {
  push(t: Token): Token[];
  end(): Token[];
}

export function streamer(op: Op): Streamer {
  let buffer: Token[] = [];
  op.setEmit((t) => buffer.push(t));
  return {
    push(t) {
      buffer = [];
      op.push(t);
      return buffer;
    },
    end() {
      buffer = [];
      op.end();
      return buffer;
    },
  };
}

// Convenience: run a batch of tokens through an op and collect all output.
export function run(op: Op, tokens: Token[]): Token[] {
  const out: Token[] = [];
  op.setEmit((t) => out.push(t));
  for (const t of tokens) op.push(t);
  op.end();
  return out;
}
