// WebAssembly backend for fused kernel segments — the same unit fused JS
// compiles (passes/fuse.ts, js.ts genSegment), with the same shape:
//
//   stage j          → wasm function st_j(input… : f64)
//   `>>` to stage j+1 → a direct call st_{j+1}(values…)
//   `>>` from the last → store into the output buffer (drained by JS)
//   `<<`             → push onto stage j's LIFO worklist in linear memory;
//                      st_j pops and runs its body until the list is empty
//   state, params    → mutable f64 globals (params evaluated once, at init)
//
// All arithmetic is f64 with IEEE semantics identical to JavaScript's, so a
// wasm segment's output is bit-identical to the JS backend's — that is the
// test. The module is emitted directly in the binary format (no assembler).

import { anyStmt, type FusedStage, type ScalarExpr, type Stmt } from '../ir.js';
import { BIN, UN } from '../scalar.js';

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
const sleb = (n: number): number[] => {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) return [...out, b];
    out.push(b | 0x80);
  }
};
const f64 = (v: number): number[] => [...new Uint8Array(new Float64Array([v]).buffer)];
const str = (s: string): number[] => [...uleb(s.length), ...[...s].map((c) => c.charCodeAt(0))];
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];

const F64 = 0x7c;
const I32 = 0x7f;
const OP = {
  unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, brIf: 0x0d,
  call: 0x10, select: 0x1b, localGet: 0x20, localSet: 0x21, globalGet: 0x23, globalSet: 0x24,
  f64Load: 0x2b, f64Store: 0x39, i32Const: 0x41, f64Const: 0x44,
  i32Eqz: 0x45, i32GtU: 0x4b, i32GeU: 0x4f, i32Add: 0x6a, i32Sub: 0x6b, i32Mul: 0x6c, i32And: 0x71, i32Or: 0x72,
  f64Eq: 0x61, f64Ne: 0x62, f64Lt: 0x63, f64Gt: 0x64, f64Le: 0x65, f64Ge: 0x66,
  f64Neg: 0x9a, f64Ceil: 0x9b, f64Floor: 0x9c, f64Sqrt: 0x9f,
  f64Add: 0xa0, f64Sub: 0xa1, f64Mul: 0xa2, f64Div: 0xa3, f64FromI32U: 0xb8,
} as const;
const VOID = 0x40;
const mem = (offset: number) => [3, ...uleb(offset)]; // align 2^3, offset

// --- the segment compiler -----------------------------------------------------------

// Memory layout: [0, PARAMS) pipeline params; the output buffer; one
// worklist stack per feeding stage; an input buffer for batched pushes.
// Sizes matter: every pipeline instance gets its own memory, so it must be
// small (megabytes per instance showed up as GC time). Depth-first feedback
// keeps worklists shallow (a subdivision leaves one sibling per level);
// overflow traps rather than corrupting.
const PAGE = 65536;
const OUT_TOKENS = 256;
const IN_TOKENS = 256;
const STACK_BYTES = 1 << 15;

export interface WasmSegment {
  bytes: Uint8Array;
  inputWidth: number;
  outputWidth: number;
  paramCount: number; // pipeline params the segment reads
  outBase: number; // byte offset of the output buffer
  inBase: number; // byte offset of the batch input buffer
  inTokens: number; // its capacity in tokens
}

export function compileSegment(stages: FusedStage[], pipelineParams: number): WasmSegment {
  const n = stages.length;
  const outWidth = stages[n - 1].kernel.outputWidth;
  const outBase = 8 * pipelineParams;
  const outLimit = outBase + 8 * outWidth * OUT_TOKENS;
  const feeds = stages.map((s) => anyStmt(s.kernel.body, (x) => x.k === 'feed'));
  const stackBase: number[] = [];
  let top = outLimit;
  for (let j = 0; j < n; j++) {
    stackBase.push(top);
    if (feeds[j]) top += STACK_BYTES;
  }
  const w0 = stages[0].kernel.inputWidth;
  const inBase = top;
  top += 8 * w0 * IN_TOKENS;
  const pages = Math.ceil(top / PAGE);

  // Globals: OUT pointer (i32), then per stage: SP (i32), params, state (f64).
  const globals: { type: number; init: number[] }[] = [];
  const g = (type: number, init: number[]) => globals.push({ type, init }) - 1;
  const OUTP = g(I32, [OP.i32Const, ...sleb(outBase)]);
  const sp = stackBase.map((b) => g(I32, [OP.i32Const, ...sleb(b)]));
  const argG = stages.map((s) => s.args.flat().map(() => g(F64, [OP.f64Const, ...f64(0)])));
  const stateG = stages.map((s) => s.kernel.stateInit.map(() => g(F64, [OP.f64Const, ...f64(0)])));

  // Function indices: 0 = imported drain; then st_0…st_{n-1}, fl_0…, init,
  // end, push (st_0, returning the output pointer so JS need not ask).
  const DRAIN = 0;
  const ST = (j: number) => 1 + j;
  const FL = (j: number) => 1 + n + j;
  const INIT = 1 + 2 * n;
  const END = 2 + 2 * n;
  const PUSH = 3 + 2 * n;
  const PUSH_ALL = 4 + 2 * n;

  // Types: one per distinct parameter count (all f64, no results).
  const typeOf = new Map<string, number>();
  const types: number[][] = [];
  const typeFor = (params: number, result: number[] = []) => {
    const key = `${params}:${result}`;
    if (!typeOf.has(key)) {
      typeOf.set(key, types.length);
      types.push([0x60, ...uleb(params), ...Array(params).fill(F64), ...uleb(result.length), ...result]);
    }
    return typeOf.get(key)!;
  };

  // One function body. Locals: f64 inputs (params or popped), then named lets.
  function fn(j: number, body: Stmt[], mode: 'step' | 'flush'): number[] {
    const k = stages[j].kernel;
    const w = k.inputWidth;
    const viaStack = mode === 'step' && feeds[j];
    const paramCount = mode === 'step' ? w : 0;
    const locals = new Map<string, number>();
    const T = (i: number) => (viaStack ? paramCount + i : i); // input i
    let next = paramCount + (viaStack ? w : 0);
    const local = (name: string) => {
      if (!locals.has(name)) locals.set(name, next++);
      return locals.get(name)!;
    };
    const code: number[] = [];
    const c = (...b: number[]): void => {
      code.push(...b);
    };

    const num = (e: ScalarExpr): void => {
      switch (e.k) {
        case 'const': return c(OP.f64Const, ...f64(e.value));
        case 'param': return c(OP.globalGet, ...uleb(argG[j][e.index]));
        case 'state': return c(OP.globalGet, ...uleb(stateG[j][e.index]));
        case 'input':
          if (mode === 'flush') throw new Error('input in a flush body');
          return c(OP.localGet, ...uleb(T(e.index)));
        case 'local': return c(OP.localGet, ...uleb(local(e.name)));
        case 'bin':
          if (BIN[e.op].cls === 'arith') { num(e.a); num(e.b); return c(BIN[e.op].wasm); }
          cond(e);
          return c(OP.f64FromI32U);
        case 'un':
          if (UN[e.op].cls === 'logic') { cond(e); return c(OP.f64FromI32U); }
          num(e.a);
          return c(UN[e.op].wasm);
        case 'select':
          num(e.then); num(e.else); cond(e.cond);
          return c(OP.select);
      }
    };
    const cond = (e: ScalarExpr): void => {
      if (e.k === 'bin' && BIN[e.op].cls === 'cmp') { num(e.a); num(e.b); return c(BIN[e.op].wasm); }
      if (e.k === 'bin' && BIN[e.op].cls === 'logic') { cond(e.a); cond(e.b); return c(BIN[e.op].wasm); }
      if (e.k === 'un' && UN[e.op].cls === 'logic') { cond(e.a); return c(UN[e.op].wasm); }
      num(e);
      c(OP.f64Const, ...f64(0));
      c(OP.f64Ne);
    };
    const stmts = (list: Stmt[]): void => {
      for (const s of list) {
        switch (s.k) {
          case 'let':
          case 'assign':
            num(s.expr);
            c(OP.localSet, ...uleb(local(s.name)));
            break;
          case 'setState':
            num(s.expr);
            c(OP.globalSet, ...uleb(stateG[j][s.index]));
            break;
          case 'emit':
            if (j + 1 < n) {
              s.values.forEach(num);
              c(OP.call, ...uleb(ST(j + 1)));
            } else {
              s.values.forEach((v, i) => { c(OP.globalGet, ...uleb(OUTP)); num(v); c(OP.f64Store, ...mem(8 * i)); });
              c(OP.globalGet, ...uleb(OUTP), OP.i32Const, ...sleb(8 * outWidth), OP.i32Add, OP.globalSet, ...uleb(OUTP));
              // Full: hand the buffer to JS (which resets OUTP).
              c(OP.globalGet, ...uleb(OUTP), OP.i32Const, ...sleb(outLimit), OP.i32GeU, OP.if, VOID, OP.call, ...uleb(DRAIN), OP.end);
            }
            break;
          case 'feed':
            s.values.forEach((v, i) => { c(OP.globalGet, ...uleb(sp[j])); num(v); c(OP.f64Store, ...mem(8 * i)); });
            c(OP.globalGet, ...uleb(sp[j]), OP.i32Const, ...sleb(8 * w), OP.i32Add, OP.globalSet, ...uleb(sp[j]));
            c(OP.globalGet, ...uleb(sp[j]), OP.i32Const, ...sleb(stackBase[j] + STACK_BYTES), OP.i32GtU, OP.if, VOID, OP.unreachable, OP.end);
            break;
          case 'if':
            cond(s.cond);
            c(OP.if, VOID);
            stmts(s.then);
            if (s.else.length > 0) { c(OP.else); stmts(s.else); }
            c(OP.end);
            break;
        }
      }
    };

    if (viaStack) {
      // Push the incoming token, then run until the worklist is empty —
      // depth-first, exactly the JS segment's `while (q.length) q.pop()`.
      for (let i = 0; i < w; i++) {
        c(OP.globalGet, ...uleb(sp[j]), OP.localGet, ...uleb(i), OP.f64Store, ...mem(8 * i));
      }
      c(OP.globalGet, ...uleb(sp[j]), OP.i32Const, ...sleb(8 * w), OP.i32Add, OP.globalSet, ...uleb(sp[j]));
      c(OP.block, VOID, OP.loop, VOID);
      c(OP.globalGet, ...uleb(sp[j]), OP.i32Const, ...sleb(stackBase[j]), OP.i32GtU, OP.i32Eqz, OP.brIf, 1);
      c(OP.globalGet, ...uleb(sp[j]), OP.i32Const, ...sleb(8 * w), OP.i32Sub, OP.globalSet, ...uleb(sp[j]));
      for (let i = 0; i < w; i++) {
        c(OP.globalGet, ...uleb(sp[j]), OP.f64Load, ...mem(8 * i), OP.localSet, ...uleb(T(i)));
      }
      stmts(body);
      c(OP.br, 0, OP.end, OP.end);
    } else {
      stmts(body);
    }
    c(OP.end);
    const extra = next - paramCount;
    return [...uleb(extra > 0 ? 1 : 0), ...(extra > 0 ? [...uleb(extra), F64] : [])].concat(code);
  }

  // init: evaluate stage arguments (over the pipeline params in memory) and
  // state initializers, in order.
  const init: number[] = [];
  const pipelineExpr = (e: ScalarExpr, j: number): void => {
    switch (e.k) {
      case 'const': init.push(OP.f64Const, ...f64(e.value)); return;
      case 'param': init.push(OP.i32Const, 0, OP.f64Load, ...mem(8 * e.index)); return;
      case 'bin':
        if (BIN[e.op].cls === 'arith') { pipelineExpr(e.a, j); pipelineExpr(e.b, j); init.push(BIN[e.op].wasm); return; }
        break;
      case 'un':
        if (UN[e.op].cls !== 'logic') { pipelineExpr(e.a, j); init.push(UN[e.op].wasm); return; }
        break;
    }
    throw new Error(`wasm: unsupported stage argument expression '${e.k}'`);
  };
  const stateExpr = (e: ScalarExpr, j: number): void => {
    switch (e.k) {
      case 'const': init.push(OP.f64Const, ...f64(e.value)); return;
      case 'param': init.push(OP.globalGet, ...uleb(argG[j][e.index])); return;
      case 'state': init.push(OP.globalGet, ...uleb(stateG[j][e.index])); return;
      case 'bin':
        if (BIN[e.op].cls === 'arith') { stateExpr(e.a, j); stateExpr(e.b, j); init.push(BIN[e.op].wasm); return; }
        break;
      case 'un':
        if (UN[e.op].cls !== 'logic') { stateExpr(e.a, j); init.push(UN[e.op].wasm); return; }
        break;
    }
    throw new Error(`wasm: unsupported state initializer '${e.k}'`);
  };
  stages.forEach((s, j) => {
    s.args.flat().forEach((a, i) => { pipelineExpr(a, j); init.push(OP.globalSet, ...uleb(argG[j][i])); });
    s.kernel.stateInit.forEach((e, i) => { stateExpr(e, j); init.push(OP.globalSet, ...uleb(stateG[j][i])); });
  });
  init.push(OP.end);

  const end: number[] = [];
  stages.forEach((_, j) => end.push(OP.call, ...uleb(FL(j))));
  end.push(OP.globalGet, ...uleb(OUTP), OP.end);
  const push: number[] = [];
  for (let i = 0; i < w0; i++) push.push(OP.localGet, ...uleb(i));
  push.push(OP.call, ...uleb(ST(0)), OP.globalGet, ...uleb(OUTP), OP.end);
  // pushAll(n): run st_0 over n tokens in the input buffer (local 1 = end
  // address, local 2 = cursor).
  const L = (i: number) => uleb(i);
  const pushAll: number[] = [
    1, 2, I32, // two i32 locals
    OP.localGet, ...L(0), OP.i32Const, ...sleb(8 * w0), OP.i32Mul, OP.i32Const, ...sleb(inBase), OP.i32Add, OP.localSet, ...L(1),
    OP.i32Const, ...sleb(inBase), OP.localSet, ...L(2),
    OP.block, VOID, OP.loop, VOID,
    OP.localGet, ...L(2), OP.localGet, ...L(1), OP.i32GeU, OP.brIf, 1,
    ...Array.from({ length: w0 }, (_, i) => [OP.localGet, ...L(2), OP.f64Load, ...mem(8 * i)]).flat(),
    OP.call, ...uleb(ST(0)),
    OP.localGet, ...L(2), OP.i32Const, ...sleb(8 * w0), OP.i32Add, OP.localSet, ...L(2),
    OP.br, 0, OP.end, OP.end,
    OP.globalGet, ...uleb(OUTP), OP.end,
  ];

  const bodies = [
    ...stages.map((s, j) => fn(j, s.kernel.body, 'step')),
    ...stages.map((s, j) => fn(j, s.kernel.epilogue, 'flush')),
    [0, ...init],
    [0, ...end],
    [0, ...push],
    pushAll,
  ];
  const pushAllType = types.push([0x60, 1, I32, 1, I32]) - 1;
  const funcTypes = [
    ...stages.map((s) => typeFor(s.kernel.inputWidth)),
    ...stages.map(() => typeFor(0)),
    typeFor(0),
    typeFor(0, [I32]),
    typeFor(w0, [I32]),
    pushAllType,
  ];
  const drainType = typeFor(0);

  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, vec(types)),
    ...section(2, vec([[...str('env'), ...str('drain'), 0x00, ...uleb(drainType)]])),
    ...section(3, vec(funcTypes.map((t) => uleb(t)))),
    ...section(5, vec([[0x00, ...uleb(pages)]])),
    ...section(6, vec(globals.map((gl) => [gl.type, 1, ...gl.init, OP.end]))),
    ...section(7, vec([
      [...str('memory'), 0x02, 0],
      [...str('push'), 0x00, ...uleb(PUSH)],
      [...str('pushAll'), 0x00, ...uleb(PUSH_ALL)],
      [...str('init'), 0x00, ...uleb(INIT)],
      [...str('end'), 0x00, ...uleb(END)],
      [...str('out'), 0x03, ...uleb(OUTP)],
    ])),
    ...section(10, vec(bodies.map((b) => [...uleb(b.length), ...b]))),
  ];
  return {
    bytes: new Uint8Array(bytes),
    inputWidth: stages[0].kernel.inputWidth,
    outputWidth: outWidth,
    paramCount: pipelineParams,
    outBase,
    inBase,
    inTokens: IN_TOKENS,
  };
}
