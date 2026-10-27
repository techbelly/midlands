// Running a pipeline compiled to WebAssembly (wasm.ts): a module's
// instances are pooled, tokens cross into linear memory and back.

import type { Emit, Op } from './op.js';

// A pipeline's module, compiled once per library (wasm.ts emits the bytes).
export const wasmModule = (bytes: number[]): WebAssembly.Module => new WebAssembly.Module(Uint8Array.from(bytes));

// Where a wasm pipeline's output and batch-input buffers sit in its memory,
// and how wide their tokens are: what the host must know to drive it.
export interface WasmLayout {
  outBase: number;
  outWidth: number;
  inBase: number;
  inWidth: number;
  inTokens: number;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  push: (...t: number[]) => number;
  pushAll: (n: number) => number;
  init: () => void;
  end: () => number;
  out: WebAssembly.Global;
}
interface Pooled {
  x: WasmExports;
  drain: () => void; // what the module's `drain` import calls: the current owner's
}
const pools = new WeakMap<WebAssembly.Module, Pooled[]>();

// A token read from linear memory as an array literal of its width (far
// cheaper for the GC than an array grown by push).
type Reader = (mem: Float64Array, p: number) => number[];
const readers = new Map<number, Reader>();
function tokenReader(width: number): Reader {
  let r = readers.get(width);
  if (!r) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    r = new Function('mem', 'p', `return [${Array.from({ length: width }, (_, i) => `mem[p + ${i}]`).join(', ')}];`) as unknown as Reader;
    readers.set(width, r);
  }
  return r;
}

// A pipeline compiled to WebAssembly (wasm.ts). Each op borrows an instance
// of the module (its own memory and state) from a pool and returns it at
// end(), so a run allocates nothing; init() resets it. push() calls straight
// into the first stage with the token's values, and whatever reached the
// output buffer is emitted when the call returns (or mid-call, if the buffer
// fills: the module calls drain).
export function wasmPipeline(module: WebAssembly.Module, layout: WasmLayout, params: number[]): Op {
  const { outBase, outWidth, inBase, inWidth, inTokens } = layout;
  let emit: Emit = () => {};
  const pool = pools.get(module) ?? [];
  pools.set(module, pool);
  let inst = pool.pop();
  if (!inst) {
    const holder: Pooled = { x: null as unknown as WasmExports, drain: () => {} };
    holder.x = new WebAssembly.Instance(module, { env: { drain: () => holder.drain() } }).exports as unknown as WasmExports;
    inst = holder;
  }
  const x = inst.x;
  let mem = new Float64Array(x.memory.buffer); // refreshed after memory grows
  const base = outBase / 8;
  const token = tokenReader(outWidth);
  // drain() (also called by wasm when the buffer fills) emits everything
  // below the output pointer and resets it.
  const drain = (stop: number = x.out.value as number) => {
    if (mem.buffer !== x.memory.buffer) mem = new Float64Array(x.memory.buffer);
    for (let p = base; p < stop / 8; p += outWidth) emit(token(mem, p));
    x.out.value = outBase;
  };
  inst.drain = () => drain();
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
        if (mem.buffer !== x.memory.buffer) mem = new Float64Array(x.memory.buffer);
        let o = inBase / 8;
        for (let j = 0; j < m; j++) {
          const t = ts[k + j];
          for (let i = 0; i < inWidth; i++) mem[o++] = t[i];
        }
        done(x.pushAll(m));
      }
    },
    end() {
      done(x.end());
      inst!.drain = () => {};
      pool.push(inst!);
    },
    setEmit(e) {
      emit = e;
    },
  };
}

