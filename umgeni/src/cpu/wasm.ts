// WebAssembly backend: a whole fused pipeline as one module, so tokens never
// leave linear memory until the final output.
//
//   stage j of part p   → wasm function st(p,j)(input… : f64)
//   `>>` to stage j+1    → a direct call st(p,j+1)(values…)
//   `>>` from a part's   → appended to that part's buffer (the barriers'
//     last stage            input), or stored in the output buffer the JS
//                           side drains (the last part)
//   `<<`                 → pushed onto the stage's LIFO worklist; the stage
//                           pops and runs its body until the list is empty.
//                           A tail feed (passes/tail.ts) sets the inputs and
//                           branches back to the top of the body instead
//   a barrier            → in place on the buffer at end of stream: a stable
//     (SortBy, GroupBy,      radix sort by the key's bits, a reversal, or a
//     Reverse, ReduceBy)     merge of same-key runs; the buffer then streams
//                           into the next part
//   state, params        → mutable f64 globals (params evaluated once, at init)
//
// Buffers grow from a bump allocator at the end of memory (memory.grow), and
// an instance is reused across runs (runtime.ts), so a run allocates nothing.
//
// All arithmetic is f64 with IEEE semantics identical to JavaScript's, and
// every barrier is the same permutation the JS runtime applies, so a wasm
// pipeline's output is bit-identical to the JS backend's — that is the test.
// The module is emitted directly in the binary format (no assembler).
//
// Not here yet: DupCat, DupZip, and a kernel with a prologue (a seed feed
// or an emit before any input). A pipeline using one keeps its other kernel
// runs in wasm and that run in JS (js.ts falls back per run; inWasm
// says which).

import { type FusedRun, type FusedStage, type ScalarExpr, type Stmt } from '../ir.js';
import { BIN, UN } from '../scalar.js';
import { stageShape, type StageShape } from '../passes/tail.js';
import type { WasmLayout } from './runtime.js';

// --- a minimal binary encoder ---------------------------------------------------

const uleb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
};
const sleb = (n: number): number[] => sleb64(BigInt(n));
const sleb64 = (n: bigint): number[] => {
  const out: number[] = [];
  for (;;) {
    const b = Number(n & 0x7fn);
    n >>= 7n;
    if ((n === 0n && (b & 0x40) === 0) || (n === -1n && (b & 0x40) !== 0)) return [...out, b];
    out.push(b | 0x80);
  }
};
const f64 = (v: number): number[] => [...new Uint8Array(new Float64Array([v]).buffer)];
const str = (s: string): number[] => [...uleb(s.length), ...[...s].map((c) => c.charCodeAt(0))];
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];

const F64 = 0x7c;
const I32 = 0x7f;
const I64 = 0x7e;
const VOID = 0x40;
const OP = {
  unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, brIf: 0x0d, call: 0x10,
  drop: 0x1a, select: 0x1b, localGet: 0x20, localSet: 0x21, localTee: 0x22, globalGet: 0x23, globalSet: 0x24,
  i32Load: 0x28, i64Load: 0x29, f64Load: 0x2b, i32Store: 0x36, i64Store: 0x37, f64Store: 0x39,
  memorySize: 0x3f, memoryGrow: 0x40, i32Const: 0x41, i64Const: 0x42, f64Const: 0x44,
  i32Eqz: 0x45, i32Eq: 0x46, i32LtU: 0x49, i32GtU: 0x4b, i32GeU: 0x4f, i64Eqz: 0x50, i64LtS: 0x53, f64Eq: 0x61, f64Ne: 0x62,
  i32Add: 0x6a, i32Sub: 0x6b, i32Mul: 0x6c, i32DivU: 0x6e, i32Shl: 0x74,
  i64And: 0x83, i64Or: 0x84, i64Xor: 0x85, i64ShrU: 0x88, f64Add: 0xa0, i32WrapI64: 0xa7, i64ExtendI32U: 0xad,
  f64ConvertI32U: 0xb8, i64ReinterpretF64: 0xbd,
} as const;
const MEMCOPY = [0xfc, 0x0a, 0x00, 0x00]; // memory.copy dest src size
const MEMFILL = [0xfc, 0x0b, 0x00]; // memory.fill dest byte size

// Instructions as byte lists.
const i32c = (n: number) => [OP.i32Const, ...sleb(n)];
const i64c = (n: bigint) => [OP.i64Const, ...sleb64(BigInt.asIntN(64, n))];
const f64c = (v: number) => [OP.f64Const, ...f64(v)];
const get = (i: number) => [OP.localGet, ...uleb(i)];
const set = (i: number) => [OP.localSet, ...uleb(i)];
const tee = (i: number) => [OP.localTee, ...uleb(i)];
const gget = (i: number) => [OP.globalGet, ...uleb(i)];
const gset = (i: number) => [OP.globalSet, ...uleb(i)];
const call = (f: number) => [OP.call, ...uleb(f)];
const ld = (op: number, align: number, off: number) => [op, align, ...uleb(off)];
const ldI32 = (off = 0) => ld(OP.i32Load, 2, off);
const stI32 = (off = 0) => ld(OP.i32Store, 2, off);
const ldI64 = (off = 0) => ld(OP.i64Load, 3, off);
const stI64 = (off = 0) => ld(OP.i64Store, 3, off);
const ldF64 = (off = 0) => ld(OP.f64Load, 3, off);
const stF64 = (off = 0) => ld(OP.f64Store, 3, off);
const add = [OP.i32Add];
const sub = [OP.i32Sub];
const mul = [OP.i32Mul];
const shl = (n: number) => [...i32c(n), OP.i32Shl];
const ifThen = (cond: number[], then: number[], els: number[] = []) =>
  [...cond, OP.if, VOID, ...then, ...(els.length ? [OP.else, ...els] : []), OP.end];
// A loop that stops when `done` (an i32) holds, checked at the top.
const loopWhile = (done: number[], body: number[]) => [OP.block, VOID, OP.loop, VOID, ...done, OP.brIf, 1, ...body, OP.br, 0, OP.end, OP.end];
// for (i = from; i < to; i += step) body
const forRange = (i: number, from: number[], to: number[], step: number[], body: number[]) =>
  [...from, ...set(i), ...loopWhile([...get(i), ...to, OP.i32GeU], [...body, ...get(i), ...step, ...add, ...set(i)])];

// A function under construction: typed parameters, locals on demand.
class Fn {
  locals: number[] = [];
  code: number[] = [];
  constructor(readonly params: number[], readonly results: number[] = []) {}
  local(type: number): number {
    this.locals.push(type);
    return this.params.length + this.locals.length - 1;
  }
  emit(...parts: number[][]): void {
    for (const p of parts) this.code.push(...p);
  }
  body(): number[] {
    const b = [...vec(this.locals.map((t) => [1, t])), ...this.code, OP.end];
    return [...uleb(b.length), ...b];
  }
}

// --- scalar expressions over an environment ---
interface Env {
  param(i: number): number[];
  state(i: number): number[];
  input(i: number): number[];
  local(name: string): number;
}
const noEnv = (what: string): Env => ({
  param: () => fail(`a parameter in ${what}`),
  state: () => fail(`state in ${what}`),
  input: () => fail(`an input in ${what}`),
  local: () => fail(`a local in ${what}`),
});
const fail = (msg: string): never => {
  throw new Error(`wasm: ${msg}`);
};
// The value of e, as f64.
function num(f: Fn, e: ScalarExpr, env: Env): void {
  switch (e.k) {
    case 'const': f.emit(f64c(e.value)); return;
    case 'param': f.emit(env.param(e.index)); return;
    case 'state': f.emit(env.state(e.index)); return;
    case 'input': f.emit(env.input(e.index)); return;
    case 'local': f.emit(get(env.local(e.name))); return;
    case 'bin':
      if (BIN[e.op].cls === 'arith') { num(f, e.a, env); num(f, e.b, env); f.emit([BIN[e.op].wasm]); return; }
      cond(f, e, env);
      f.emit([OP.f64ConvertI32U]);
      return;
    case 'un':
      if (UN[e.op].cls === 'logic') { cond(f, e, env); f.emit([OP.f64ConvertI32U]); return; }
      num(f, e.a, env);
      f.emit([UN[e.op].wasm]);
      return;
    case 'select':
      num(f, e.then, env); num(f, e.else, env); cond(f, e.cond, env);
      f.emit([OP.select]);
      return;
  }
}
// The truth of e, as i32.
function cond(f: Fn, e: ScalarExpr, env: Env): void {
  if (e.k === 'bin' && BIN[e.op].cls === 'cmp') { num(f, e.a, env); num(f, e.b, env); f.emit([BIN[e.op].wasm]); return; }
  if (e.k === 'bin' && BIN[e.op].cls === 'logic') { cond(f, e.a, env); cond(f, e.b, env); f.emit([BIN[e.op].wasm]); return; }
  if (e.k === 'un' && UN[e.op].cls === 'logic') { cond(f, e.a, env); f.emit([UN[e.op].wasm]); return; }
  num(f, e, env);
  f.emit(f64c(0), [OP.f64Ne]);
}

// Store a token's w values at the pointer a global holds, then move it on:
// a worklist push, or an append to a buffer. `value(i)` emits the i-th value.
function pushToken(f: Fn, ptr: number, w: number, value: (i: number) => void): void {
  for (let i = 0; i < w; i++) {
    f.emit(gget(ptr));
    value(i);
    f.emit(stF64(8 * i));
  }
  f.emit(gget(ptr), i32c(8 * w), add, gset(ptr));
}

// sort(base, top, wb, keyOff): a stable LSD radix sort of the tokens in
// [base, top) by the f64 at keyOff: the key's bits made monotonic (-0 as 0,
// negatives flipped), eight 8-bit digits, indices permuted, the tokens
// gathered once at the end. Scratch sits above the heap and is dropped.
function sortBody(f: Fn, HEAP: number, ENSURE: number): void {
  const [base, top, wb, keyOff] = [0, 1, 2, 3];
  const n = f.local(I32), keys = f.local(I32), idxA = f.local(I32), idxB = f.local(I32), counts = f.local(I32), copy = f.local(I32);
  const i = f.local(I32), d = f.local(I32), c = f.local(I32), t = f.local(I32), bits = f.local(I64), vary = f.local(I64), first = f.local(I64);
  // The digit of the key at the address on the stack.
  const digit = [...ldI64(), ...get(d), OP.i64ExtendI32U, OP.i64ShrU, ...i64c(0xffn), OP.i64And, OP.i32WrapI64];
  const at = (arr: number, idx: number[], shift: number) => [...get(arr), ...idx, ...shl(shift), ...add];
  f.emit(get(top), get(base), sub, get(wb), [OP.i32DivU], set(n));
  // Scratch: keys u64[n], idxA i32[n], idxB i32[n], counts i32[256], a copy of the tokens.
  f.emit(gget(HEAP), set(keys));
  f.emit(at(keys, get(n), 3), set(idxA));
  f.emit(at(idxA, get(n), 2), set(idxB));
  f.emit(at(idxB, get(n), 2), set(counts));
  f.emit(get(counts), i32c(1024), add, set(copy));
  f.emit(get(copy), get(top), add, get(base), sub, gget(HEAP), sub, call(ENSURE));
  // Keys and identity indices; `vary` collects the bits in which any two
  // keys differ, so passes over digits no key varies in are skipped.
  f.emit(i64c(0n), set(vary), i64c(0n), set(first));
  f.emit(forRange(i, i32c(0), get(n), i32c(1), [
    ...get(base), ...get(i), ...get(wb), ...mul, ...add, ...get(keyOff), ...add, ...ldF64(), ...f64c(0), OP.f64Add, OP.i64ReinterpretF64, ...set(bits),
    ...get(bits), ...i64c(0n), OP.i64LtS, OP.if, I64, ...get(bits), ...i64c(-1n), OP.i64Xor, OP.else, ...get(bits), ...i64c(1n << 63n), OP.i64Xor, OP.end, ...set(bits),
    ...ifThen([...get(i), OP.i32Eqz], [...get(bits), ...set(first)]),
    ...get(vary), ...get(bits), ...get(first), OP.i64Xor, OP.i64Or, ...set(vary),
    ...at(keys, get(i), 3), ...get(bits), ...stI64(),
    ...at(idxA, get(i), 2), ...get(i), ...stI32(),
  ]));
  f.emit(get(copy), get(base), get(top), get(base), sub, MEMCOPY);
  // Eight digit passes, least significant first.
  f.emit(forRange(d, i32c(0), i32c(64), i32c(8), [
    OP.block, VOID, // skipped when no key varies in this digit
    ...ifThen([...get(vary), ...get(d), OP.i64ExtendI32U, OP.i64ShrU, ...i64c(0xffn), OP.i64And, OP.i64Eqz], [OP.br, 1]),
    ...get(counts), ...i32c(0), ...i32c(1024), ...MEMFILL,
    ...forRange(i, i32c(0), get(n), i32c(1), [
      ...at(keys, [...at(idxA, get(i), 2), ...ldI32()], 3), ...digit, ...shl(2), ...get(counts), ...add, ...set(c),
      ...get(c), ...get(c), ...ldI32(), ...i32c(1), ...add, ...stI32(),
    ]),
    // Exclusive prefix sums: counts[c] = number of keys with a smaller digit.
    ...i32c(0), ...set(t),
    ...forRange(c, i32c(0), i32c(256), i32c(1), [
      ...at(counts, get(c), 2), ...tee(i), ...ldI32(), ...get(i), ...get(t), ...stI32(), ...get(t), ...add, ...set(t),
    ]),
    // Scatter, in order: stable.
    ...forRange(i, i32c(0), get(n), i32c(1), [
      ...at(idxA, get(i), 2), ...ldI32(), ...set(c),
      ...at(keys, get(c), 3), ...digit, ...shl(2), ...get(counts), ...add, ...set(t),
      ...at(idxB, [...get(t), ...ldI32()], 2), ...get(c), ...stI32(),
      ...get(t), ...get(t), ...ldI32(), ...i32c(1), ...add, ...stI32(),
    ]),
    ...get(idxA), ...get(idxB), ...set(idxA), ...set(idxB),
    OP.end,
  ]));
  // Gather the tokens into their sorted places.
  f.emit(forRange(i, i32c(0), get(n), i32c(1), [
    ...get(base), ...get(i), ...get(wb), ...mul, ...add,
    ...get(copy), ...at(idxA, get(i), 2), ...ldI32(), ...get(wb), ...mul, ...add,
    ...get(wb), ...MEMCOPY,
  ]));
}

// reverse(base, top, wb): tokens swapped from both ends, word by word.
function reverseBody(f: Fn): void {
  const [base, top, wb] = [0, 1, 2];
  const a = f.local(I32), b = f.local(I32), k = f.local(I32), t = f.local(I64);
  f.emit(get(base), set(a), get(top), get(wb), sub, set(b));
  f.emit(loopWhile([...get(a), ...get(b), OP.i32GeU], [
    ...forRange(k, i32c(0), get(wb), i32c(8), [
      ...get(a), ...get(k), ...add, ...ldI64(), ...set(t),
      ...get(a), ...get(k), ...add, ...get(b), ...get(k), ...add, ...ldI64(), ...stI64(),
      ...get(b), ...get(k), ...add, ...get(t), ...stI64(),
    ]),
    ...get(a), ...get(wb), ...add, ...set(a), ...get(b), ...get(wb), ...sub, ...set(b),
  ]));
}

// --- the pipeline compiler ----------------------------------------------------------

// Memory layout: [0, PARAMS) pipeline params; the output buffer; the batch
// input buffer; one worklist stack per feeding stage; then the heap, from
// which barrier buffers and sort scratch are bump-allocated (memory grows).
const PAGE = 65536;
const OUT_TOKENS = 256;
const IN_TOKENS = 256;
const STACK_BYTES = 1 << 15;

type Barrier = Extract<FusedRun, { k: 'sortBy' | 'groupBy' | 'reduceBy' | 'reverse' }>;

// What this file compiles: kernel runs with no prologue, and the four
// in-place barriers.
export const inWasm = (s: FusedRun): boolean =>
  s.k === 'kernels' ? s.stages.every((st) => st.kernel.prologue.length === 0) : s.k !== 'dupCat' && s.k !== 'dupZip';

export interface WasmPipeline {
  bytes: Uint8Array;
  layout: WasmLayout; // what runtime.ts's wasmPipeline needs to drive it
}

// A section of the pipeline: a run of kernels, and the barriers applied to
// its output before the next section reads it (none after the last). A
// pipeline that starts or ends with a barrier has an empty section there.
interface Section {
  stages: FusedStage[];
  inputWidth: number;
  outputWidth: number; // what the stages leave: the width of the buffer's tokens
  barriers: Barrier[];
}

function partition(runs: FusedRun[], inputWidth: number): Section[] {
  const sections: Section[] = [];
  let width = inputWidth; // the stream's width at this point in the pipeline
  const open = (): Section => {
    const section = { stages: [], inputWidth: width, outputWidth: width, barriers: [] };
    sections.push(section);
    return section;
  };
  let section = open();
  for (const s of runs) {
    if (!inWasm(s)) throw new Error(`wasm: ${s.k === 'kernels' ? 'a prologue' : s.k} is not compiled to wasm yet`);
    if (s.k === 'identity' || s.k === 'dupCat' || s.k === 'dupZip') continue; // the dups were refused above; naming them narrows s
    if (s.k === 'kernels') {
      if (section.barriers.length > 0) section = open(); // a new section reads what the barriers leave
      section.stages.push(...s.stages);
      width = section.outputWidth = s.stages[s.stages.length - 1].kernel.outputWidth;
    } else {
      section.barriers.push(s);
      if (s.k === 'reduceBy') width = s.width;
    }
  }
  if (section.barriers.length > 0) open();
  return sections;
}

// A stage's place in the module: how its body runs (passes/tail.ts), its
// worklist if it needs one, the globals holding its arguments and state,
// its two functions, and the function its emit calls: the next stage, or
// the part's last emit.
interface Slot {
  stage: FusedStage;
  shape: StageShape;
  stackBase: number;
  sp: number;
  args: number[];
  state: number[];
  st: number; // the per-token body
  fl: number; // the flush body
  next: number;
}

// A section's place in the module: its stages' slots, its entry (the first
// stage, or with no stages its emit), its last stage's emit, and, unless it
// is the last, the buffer its output goes to (base and top globals) with
// the barriers applied there, each ReduceBy as a function of its own.
interface Part {
  inputWidth: number;
  outputWidth: number;
  slots: Slot[];
  entry: number;
  emit: number;
  out: { base: number; top: number; barriers: { b: Barrier; reduce: number }[] } | null;
}

export function compilePipeline(runs: FusedRun[], inputWidth: number, pipelineParams: number): WasmPipeline {
  const sections = partition(runs, inputWidth);
  const w0 = sections[0].inputWidth;
  const outWidth = sections[sections.length - 1].outputWidth;

  // The fixed layout.
  const outBase = 8 * pipelineParams;
  const outLimit = outBase + 8 * outWidth * OUT_TOKENS;
  const inBase = outLimit;
  let top = inBase + 8 * w0 * IN_TOKENS;

  // Globals.
  const globals: { type: number; init: number[] }[] = [];
  const g = (type: number, init: number[]) => globals.push({ type, init }) - 1;
  const OUTP = g(I32, i32c(outBase));

  // Functions: declared first (so calls can be emitted before bodies exist),
  // defined below. Index 0 is the imported drain.
  const sigs: { params: number[]; results: number[] }[] = [];
  const bodies = new Map<number, Fn>();
  const declare = (params: number[], results: number[] = []) => sigs.push({ params, results });
  const define = (index: number, build: (f: Fn) => void) => {
    const f = new Fn(sigs[index - 1].params, sigs[index - 1].results);
    build(f);
    bodies.set(index, f);
  };
  const DRAIN = 0;
  const ENSURE = declare([I32]); // ensure(bytes): grow until HEAP + bytes fits

  const parts: Part[] = sections.map((section, p): Part => {
    const emit = declare(Array(section.outputWidth).fill(F64));
    const entry = declare(Array(section.inputWidth).fill(F64));
    const slots = section.stages.map((stage): Slot => {
      const shape = stageShape(stage.kernel.body);
      const stackBase = top;
      if (shape === 'worklist') top += STACK_BYTES;
      return {
        stage, shape, stackBase,
        sp: g(I32, i32c(stackBase)),
        args: stage.args.flat().map(() => g(F64, f64c(0))),
        state: stage.kernel.stateInit.map(() => g(F64, f64c(0))),
        st: declare(Array(stage.kernel.inputWidth).fill(F64)),
        fl: declare([]),
        next: -1,
      };
    });
    slots.forEach((s, j) => { s.next = j + 1 < slots.length ? slots[j + 1].st : emit; });
    const out = p + 1 < sections.length
      ? { base: g(I32, i32c(0)), top: g(I32, i32c(0)), barriers: section.barriers.map((b) => ({ b, reduce: b.k === 'reduceBy' ? declare([]) : -1 })) }
      : null;
    return { inputWidth: section.inputWidth, outputWidth: section.outputWidth, slots, entry, emit, out };
  });
  const slots = parts.flatMap((part) => part.slots);
  const heap0 = top;
  const pages = Math.ceil((heap0 + PAGE) / PAGE);
  const HEAP = g(I32, i32c(heap0));
  const LIMIT = g(I32, i32c(pages * PAGE));

  // A buffer opens at the heap top: empty, above everything allocated so far.
  const openBuffer = (f: Fn, out: { base: number; top: number }) => f.emit(gget(HEAP), gset(out.base), gget(HEAP), gset(out.top));

  const SORT = declare([I32, I32, I32, I32]); // sort(base, top, wb, keyOff)
  const REVERSE = declare([I32, I32, I32]); // reverse(base, top, wb)
  const INIT = declare([]);
  const END = declare([], [I32]);
  const PUSH = declare(Array(w0).fill(F64), [I32]);
  const PUSH_ALL = declare([I32], [I32]);

  // The tokens in [from, to), `stride` bytes apart, the first `width` values
  // of each fed to `entry` in turn.
  const stream = (cur: number, from: number[], to: number[], stride: number, width: number, entry: number): number[] =>
    forRange(cur, from, to, i32c(stride), [
      ...Array.from({ length: width }, (_, i) => [...get(cur), ...ldF64(8 * i)]).flat(),
      ...call(entry),
    ]);

  // --- stages ---
  for (const s of slots) {
    const k = s.stage.kernel;
    const w = k.inputWidth;
    const { sp, stackBase } = s;
    const feeds = s.shape !== 'straight';
    const build = (f: Fn, list: Stmt[], flush: boolean) => {
      const locals = new Map<string, number>();
      // A feeding stage's inputs are locals it pops into; otherwise they are its parameters.
      const inputs = flush ? [] : Array.from({ length: w }, (_, i) => (feeds ? f.local(F64) : i));
      const env: Env = {
        param: (i) => gget(s.args[i]),
        state: (i) => gget(s.state[i]),
        input: (i) => (flush ? fail('an input in a flush body') : get(inputs[i])),
        local: (name) => {
          if (!locals.has(name)) locals.set(name, f.local(F64));
          return locals.get(name)!;
        },
      };
      // `depth`: enclosing ifs, so a tail feed can branch to the loop around the body.
      const run = (list: Stmt[], depth: number): void => {
        for (const st of list) {
          switch (st.k) {
            case 'let':
            case 'assign':
              num(f, st.expr, env);
              f.emit(set(env.local(st.name)));
              break;
            case 'setState':
              num(f, st.expr, env);
              f.emit(gset(s.state[st.index]));
              break;
            case 'emit':
              st.values.forEach((v) => num(f, v, env));
              f.emit(call(s.next));
              break;
            case 'feed':
              if (st.tail) {
                // The values first (they read the inputs), then the inputs; then round again.
                const next = st.values.map(() => f.local(F64));
                st.values.forEach((v, i) => { num(f, v, env); f.emit(set(next[i])); });
                next.forEach((n, i) => f.emit(get(n), set(inputs[i])));
                f.emit([OP.br, ...uleb(depth)]);
                break;
              }
              pushToken(f, sp, w, (i) => num(f, st.values[i], env));
              f.emit(ifThen([...gget(sp), ...i32c(stackBase + STACK_BYTES), OP.i32GtU], [OP.unreachable]));
              break;
            case 'if':
              cond(f, st.cond, env);
              f.emit([OP.if, VOID]);
              run(st.then, depth + 1);
              if (st.else.length > 0) { f.emit([OP.else]); run(st.else, depth + 1); }
              f.emit([OP.end]);
              break;
          }
        }
      };
      if (!flush && s.shape === 'worklist') {
        // Push the incoming token and pop it back; then run the body, popping
        // the next token at the bottom of the loop until the worklist is empty
        // — depth-first, exactly the JS segment's loop. A tail feed branches
        // to the top of the loop, past the pop.
        pushToken(f, sp, w, (i) => f.emit(get(i)));
        const pop = [...gget(sp), ...i32c(8 * w), ...sub, ...gset(sp)];
        for (let i = 0; i < w; i++) pop.push(...gget(sp), ...ldF64(8 * i), ...set(inputs[i]));
        f.emit(pop, [OP.block, VOID, OP.loop, VOID]);
        run(list, 0);
        f.emit(gget(sp), i32c(stackBase), [OP.i32GtU, OP.i32Eqz, OP.brIf, 1], pop, [OP.br, 0, OP.end, OP.end]);
      } else if (!flush && s.shape === 'loop') {
        // Every feed is a tail feed: the body loops over one token, no worklist.
        for (let i = 0; i < w; i++) f.emit(get(i), set(inputs[i]));
        f.emit([OP.block, VOID, OP.loop, VOID]);
        run(list, 0);
        f.emit([OP.br, 1, OP.end, OP.end]);
      } else {
        run(list, 0);
      }
    };
    define(s.st, (f) => build(f, k.body, false));
    define(s.fl, (f) => build(f, k.flush, true));
  }

  // ensure(bytes): the heap has `bytes` free above HEAP, growing memory if not.
  define(ENSURE, (f) => {
    const need = f.local(I32);
    f.emit(gget(HEAP), get(0), add, set(need));
    f.emit(ifThen([...get(need), ...gget(LIMIT), OP.i32GtU], [
      ...get(need), ...gget(LIMIT), ...sub, ...i32c(PAGE - 1), ...add, ...i32c(PAGE), OP.i32DivU, OP.memoryGrow, 0x00, OP.drop,
      OP.memorySize, 0x00, ...i32c(PAGE), ...mul, ...gset(LIMIT),
    ]));
  });

  // A part's last emit: append to its buffer (the top of the heap), or store
  // to OUT and hand the buffer to JS when full.
  for (const part of parts) define(part.emit, (f) => {
    const w = part.outputWidth;
    if (part.out) {
      const { top } = part.out;
      f.emit(i32c(8 * w), call(ENSURE));
      pushToken(f, top, w, (i) => f.emit(get(i)));
      f.emit(gget(top), gset(HEAP));
    } else {
      pushToken(f, OUTP, w, (i) => f.emit(get(i)));
      f.emit(ifThen([...gget(OUTP), ...i32c(outLimit), OP.i32GeU], call(DRAIN)));
    }
  });

  // A part's entry: its first stage, or (no stages) its emit.
  for (const part of parts) define(part.entry, (f) => {
    for (let i = 0; i < part.inputWidth; i++) f.emit(get(i));
    f.emit(call(part.slots[0]?.st ?? part.emit));
  });

  define(SORT, (f) => sortBody(f, HEAP, ENSURE));
  define(REVERSE, reverseBody);

  // reduce: merge adjacent same-key tokens of a buffer in place (the GroupBy
  // before it made equal keys adjacent); listed fields combine, the others
  // keep the first token's values.
  for (const part of parts) {
    if (!part.out) continue;
    const { base, top } = part.out;
    for (const { b, reduce } of part.out.barriers) {
      if (b.k !== 'reduceBy') continue;
      define(reduce, (f) => {
        const wb = 8 * b.width;
        const rd = f.local(I32), wr = f.local(I32), has = f.local(I32), same = f.local(I32), k = f.local(I32);
        const ra = f.local(F64), rb = f.local(F64);
        const env: Env = { ...noEnv('a ReduceBy operator'), local: (name) => (name === '#ra' ? ra : rb) };
        f.emit(gget(base), set(wr), i32c(0), set(has));
        const prev = (off: number) => [...get(wr), ...i32c(wb), ...sub, ...ldF64(off)];
        f.emit(forRange(rd, gget(base), gget(top), i32c(wb), [
          // same: a token has been written, and every key equals its key
          ...get(has), ...set(same),
          ...b.keyIndexes.flatMap((ki) => [
            ...get(same), OP.if, I32, ...prev(8 * ki), ...get(rd), ...ldF64(8 * ki), OP.f64Eq, OP.else, ...i32c(0), OP.end, ...set(same),
          ]),
          ...ifThen(get(same), b.fields.flatMap((fld) => {
            const op = new Fn([]);
            num(op, fld.op, env);
            return [
              ...prev(8 * fld.index), ...set(ra), ...get(rd), ...ldF64(8 * fld.index), ...set(rb),
              ...get(wr), ...i32c(wb), ...sub, ...op.code, ...stF64(8 * fld.index),
            ];
          }), [
            ...forRange(k, i32c(0), i32c(wb), i32c(8), [...get(wr), ...get(k), ...add, ...get(rd), ...get(k), ...add, ...ldI64(), ...stI64()]),
            ...get(wr), ...i32c(wb), ...add, ...set(wr), ...i32c(1), ...set(has),
          ]),
        ]));
        f.emit(get(wr), gset(top));
      });
    }
  }

  // init: reset the allocator, output and worklists; evaluate stage
  // arguments (over the pipeline params in memory) and state initializers.
  define(INIT, (f) => {
    f.emit(i32c(outBase), gset(OUTP), i32c(heap0), gset(HEAP), [OP.memorySize, 0x00], i32c(PAGE), mul, gset(LIMIT));
    if (parts[0].out) openBuffer(f, parts[0].out);
    const argEnv: Env = { ...noEnv('a stage argument'), param: (i) => [...i32c(0), ...ldF64(8 * i)] };
    for (const s of slots) {
      f.emit(i32c(s.stackBase), gset(s.sp));
      s.stage.args.flat().forEach((a, i) => { num(f, a, argEnv); f.emit(gset(s.args[i])); });
      const env: Env = { ...noEnv('a state initializer'), param: (i) => gget(s.args[i]), state: (i) => gget(s.state[i]) };
      s.stage.kernel.stateInit.forEach((e, i) => { num(f, e, env); f.emit(gset(s.state[i])); });
    }
  });

  // end(): flush each part in turn; between parts, apply the barriers to
  // the buffer and stream it into the next part.
  define(END, (f) => {
    const cur = f.local(I32);
    parts.forEach((part, p) => {
      for (const s of part.slots) f.emit(call(s.fl));
      if (!part.out) return;
      const { base, top, barriers } = part.out;
      const wb = 8 * part.outputWidth;
      const buf = [...gget(base), ...gget(top)];
      for (const { b, reduce } of barriers) {
        switch (b.k) {
          case 'sortBy':
          case 'groupBy': for (const key of [...b.keyIndexes].reverse()) f.emit(buf, i32c(wb), i32c(8 * key), call(SORT)); break;
          case 'reverse': f.emit(buf, i32c(wb), call(REVERSE)); break;
          case 'reduceBy': f.emit(call(reduce)); break;
        }
      }
      // The next part's buffer starts at the heap top, above this one.
      const next = parts[p + 1];
      if (next.out) openBuffer(f, next.out);
      f.emit(stream(cur, gget(base), gget(top), wb, next.inputWidth, next.entry));
    });
    f.emit(gget(OUTP));
  });

  // push(token): into part 0; returns the output pointer so JS need not ask.
  define(PUSH, (f) => {
    for (let i = 0; i < w0; i++) f.emit(get(i));
    f.emit(call(parts[0].entry), gget(OUTP));
  });
  // pushAll(n): part 0 over n tokens in the input buffer.
  define(PUSH_ALL, (f) => {
    const end = f.local(I32), cur = f.local(I32);
    f.emit(get(0), i32c(8 * w0), mul, i32c(inBase), add, set(end));
    f.emit(stream(cur, i32c(inBase), get(end), 8 * w0, w0, parts[0].entry));
    f.emit(gget(OUTP));
  });

  const bytes = encodeModule(sigs, bodies, globals, pages, { push: PUSH, pushAll: PUSH_ALL, init: INIT, end: END, out: OUTP });
  return { bytes, layout: { outBase, outWidth, inBase, inWidth: w0, inTokens: IN_TOKENS } };
}

// The module's bytes: its functions' types (deduplicated), the drain import,
// the memory, the globals, the exports a host drives it by, and the bodies.
// Function index 0 is the import; sigs and bodies are the rest, in order.
function encodeModule(
  sigs: { params: number[]; results: number[] }[],
  bodies: Map<number, Fn>,
  globals: { type: number; init: number[] }[],
  pages: number,
  exports: { push: number; pushAll: number; init: number; end: number; out: number },
): Uint8Array {
  const typeOf = new Map<string, number>();
  const types: number[][] = [];
  const typeFor = (params: number[], results: number[]) => {
    const key = `${params}:${results}`;
    if (!typeOf.has(key)) {
      typeOf.set(key, types.length);
      types.push([0x60, ...vec(params.map((t) => [t])), ...vec(results.map((t) => [t]))]);
    }
    return typeOf.get(key)!;
  };
  const drainType = typeFor([], []);
  const funcTypes = sigs.map((s) => typeFor(s.params, s.results));
  const funcBodies = sigs.map((_, i) => {
    const f = bodies.get(i + 1);
    if (!f) fail(`function ${i + 1} has no body`);
    return f!.body();
  });
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, vec(types)),
    ...section(2, vec([[...str('env'), ...str('drain'), 0x00, ...uleb(drainType)]])),
    ...section(3, vec(funcTypes.map((t) => uleb(t)))),
    ...section(5, vec([[0x00, ...uleb(pages)]])),
    ...section(6, vec(globals.map((gl) => [gl.type, 1, ...gl.init, OP.end]))),
    ...section(7, vec([
      [...str('memory'), 0x02, 0],
      [...str('push'), 0x00, ...uleb(exports.push)],
      [...str('pushAll'), 0x00, ...uleb(exports.pushAll)],
      [...str('init'), 0x00, ...uleb(exports.init)],
      [...str('end'), 0x00, ...uleb(exports.end)],
      [...str('out'), 0x03, ...uleb(exports.out)],
    ])),
    ...section(10, vec(funcBodies)),
  ]);
}
