// GPU lowering of fused pipelines: one rule per declaration.
//
// The lowering folds over a fused pipeline's segments, carrying the stream's
// representation on the GPU:
//
//   Dense   a buffer of n tokens (the host's upload)
//   Grid    one cell per key tuple, after GroupBy → ReduceBy: each reduced
//           field accumulated as a fixed-point integer by atomics
//
// and emits one compute pass per run of kernels:
//
//   over tokens     one thread per Dense token runs the kernels' bodies,
//                   fused as the JS backend fuses them: emit is a call to the
//                   next stage; a feeding stage keeps a per-thread worklist
//   over segments   one thread per major-key bucket of a Grid walks the minor
//                   key, reconstructs each token and runs the kernels with
//                   thread-local state; flush bodies run at the segment's end
//
// Every rule's precondition is a declaration in the source, and the error for
// a failed one names it:
//   - GroupBy must be unstable, with a ReduceBy after it whose operators have
//     an atomic (so far +): unordered groups license unordered accumulation
//   - a kernel may write state only where it declares a scan or a window by
//     the grid's major key, which makes the segments independent
//   - prologue and flush bodies run once per stream, so they need a segment
//
// What the pipeline's final emits become is the host's business, a Sink
// (execute.ts): coverage into an image, or tokens appended to a buffer.
//
// The Grid rule's assumption, stated: a cell's key is reconstructed as
// bucket + 0.5, so keys must already lie on the half-integer lattice (pixel
// centres), as DecomposeBeziers emits them. GroupBy's exact equality and the
// grid's floor then agree.

import { allStmts, anyStmt, type FusedIR, type FusedStage, type KernelIR } from '../ir.js';
import { needsWorklist } from '../passes/tail.js';
import { wgslBody, wgslExpr, WORKGROUP_SIZE, type WgslEnv } from './wgsl.js';

export class LowerError extends Error {}

export const FIXED_SCALE = 65536;

// A pass's bindings, in binding order. The host supplies a buffer per role;
// the shader declares each from the same list (execute.ts builds the bind
// group layouts from it too, so the two cannot disagree).
export interface Binding {
  name: string;
  role: 'meta' | 'input' | 'params' | 'grid' | 'overflow' | 'sink';
  access: 'uniform' | 'read' | 'read_write';
  type: string; // WGSL
}

// Where the last stage's emits go. Its WGSL may use META and its own bindings.
export interface Sink {
  bindings: Binding[];
  emit(vals: string[], indent: string): string;
}

export interface Pass {
  name: string;
  wgsl: string;
  bindings: Binding[];
  over: 'tokens' | 'segments'; // dispatch: one thread per token, or per major-key bucket
}

export interface Plan {
  name: string;
  passes: Pass[];
  inputWidth: number;
  paramWidth: number;
  extent: number[]; // buckets per GroupBy key, major first
  cells: number;
  grids: string[]; // grid buffers: cells × 4 bytes of i32 each
}

export interface LowerOptions {
  extent: number[];
  sink: Sink;
  stackCap?: number; // per-thread worklist capacity (bounds pending siblings, not total work)
}

// Every pass reads the same uniform: the token count, the grid's extents, and
// the band it works on (segments segBase…segEnd, minor keys minBase…minEnd),
// so a host can bound a pass to a path's bounding box.
export const META_WGSL = 'struct Meta { n : u32, major : u32, minor : u32, segBase : u32, segEnd : u32, minBase : u32, minEnd : u32, pad : u32 }';
export const META_BYTES = 32;
const META: Binding = { name: 'META', role: 'meta', access: 'uniform', type: 'Meta' };

interface Grid {
  keys: number[]; // token slots, major first
  fields: { index: number; grid: string }[];
  width: number;
}

export function lowerPipeline(fused: FusedIR, opts: LowerOptions): Plan {
  const { name, paramWidth } = fused;
  const { extent } = opts;
  if (extent.length < 1 || extent.length > 2) throw new LowerError(`'${name}': grids have one or two keys, given ${extent.length} extents`);
  const passes: Pass[] = [];
  const grids: string[] = [];
  let repr: Grid | null = null; // null: Dense
  let width = inputWidthOf(fused);
  let pending: FusedStage[] = [];

  const flush = (sink: Sink) => {
    const o = { name, paramWidth, cap: opts.stackCap ?? 128, sink };
    passes.push(repr ? segmentsPass(repr, pending, o) : tokensPass(width, pending, o));
    if (pending.length > 0) width = pending[pending.length - 1].kernel.outputWidth;
    pending = [];
  };

  const segs = fused.segments;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.k === 'identity') continue;
    if (s.k === 'kernels') {
      pending.push(...s.stages);
      continue;
    }
    if (s.k === 'groupBy') {
      const r = segs[i + 1];
      if (r?.k !== 'reduceBy') throw new LowerError(`'${name}': GroupBy without a ReduceBy after it needs a sort, which has no parallel lowering`);
      if (s.stable) throw new LowerError(`'${name}': GroupBy stable cannot lower to atomic grids (order would matter)`);
      if (s.keyIndexes.length !== extent.length) throw new LowerError(`'${name}': GroupBy has ${s.keyIndexes.length} keys, but the host gave ${extent.length} extents`);
      for (const f of r.fields) {
        if (!(f.op.k === 'bin' && f.op.op === 'add')) throw new LowerError(`'${name}': ReduceBy combines a field with an operator that has no atomic (only '+' so far)`);
      }
      const covered = new Set([...s.keyIndexes, ...r.fields.map((f) => f.index)]);
      if (covered.size !== r.width) throw new LowerError(`'${name}': a grid holds keys and reduced fields only; the token has other fields too`);
      const grid: Grid = { keys: s.keyIndexes, width: r.width, fields: r.fields.map((f) => ({ index: f.index, grid: `G${grids.length + r.fields.indexOf(f)}` })) };
      grids.push(...grid.fields.map((f) => f.grid));
      flush(gridSink(grid));
      repr = grid;
      width = r.width;
      i++; // the ReduceBy
      continue;
    }
    if (s.k === 'reduceBy') throw new LowerError(`'${name}': ReduceBy without a GroupBy before it`);
    const nile = { sortBy: 'SortBy', reverse: 'Reverse', dupCat: 'DupCat', dupZip: 'DupZip' }[s.k];
    throw new LowerError(`'${name}': ${nile} needs the whole stream in order, which has no parallel lowering`);
  }
  flush(opts.sink);
  return { name, passes, inputWidth: inputWidthOf(fused), paramWidth, extent, cells: extent.reduce((a, b) => a * b, 1), grids };
}

function inputWidthOf(f: FusedIR): number {
  for (let i = 0; i < f.segments.length; i++) {
    const s = f.segments[i];
    if (s.k === 'kernels') return s.stages[0].kernel.inputWidth;
    if (s.k === 'reduceBy') return s.width;
  }
  throw new LowerError(`'${f.name}': cannot tell its input width`);
}

// --- the stages of one pass -------------------------------------------------

interface PassOptions {
  name: string;
  paramWidth: number;
  cap: number;
  sink: Sink;
}

interface Stages {
  decls: string[]; // module-scope: state and worklists, one set per stage
  fns: string[]; // st0…, fl0…: callees first
  init: string[]; // at thread start
  flush: string[]; // at segment end
  feeds: boolean;
}

const writesState = (k: KernelIR) => anyStmt([...k.body, ...k.epilogue], (s) => s.k === 'setState');

// Which output slot carries the input slot `key` unchanged through every emit
// of the per-token body (null: none does).
function carried(k: KernelIR, key: number): number | null {
  const emits = [...allStmts(k.body)].flatMap((s) => (s.k === 'emit' ? [s.values] : []));
  if (emits.length === 0) return null;
  for (let j = 0; j < k.outputWidth; j++) {
    if (emits.every((v) => v[j].k === 'input' && (v[j] as { index: number }).index === key)) return j;
  }
  return null;
}

// Stage j's body as fn st{j}(a0, …): emit calls st{j+1} (or the sink), feed
// pushes onto the stage's worklist, state is the stage's private array.
// `key`: the input slot carrying the grid's major key (segments passes), so a
// stage declaring a scan or window can be checked against it.
function genStages(stages: FusedStage[], width: number, o: PassOptions, key: number | null): Stages {
  const P: WgslEnv = { param: (i) => `P[${i}u]`, state: () => fail('state'), input: () => fail('input'), emit: () => '', feed: () => '' };
  const out: Stages = { decls: [], fns: [], init: [], flush: [], feeds: false };
  const call = (j: number, vals: string[]) => `st${j}(${vals.join(', ')});`;
  if (stages.length === 0) {
    const args = Array.from({ length: width }, (_, i) => `a${i}`);
    out.fns.push(`fn st0(${args.map((a) => `${a} : f32`).join(', ')}) {\n${o.sink.emit(args, '  ')}\n}`);
    return out;
  }
  const fns: string[] = [];
  stages.forEach((stage, j) => {
    const k = stage.kernel;
    const who = `'${k.name}' in '${o.name}'`;
    if (k.init.length > 0) throw new LowerError(`${who}: a prologue runs once per stream, which has no parallel lowering`);
    if (key === null && k.epilogue.length > 0) throw new LowerError(`${who}: a flush body runs once per stream; it needs a segment (GroupBy → ReduceBy before it)`);
    if (writesState(k)) {
      const a = k.access;
      if (key === null) throw new LowerError(`${who}: carries state across tokens; it needs a declared scan or window over a grouped stream (GroupBy → ReduceBy before it)`);
      if (!a) throw new LowerError(`${who}: carries state across tokens without declaring a scan or window by the grid's major key`);
      if (a.scan && a.scan.key !== key) throw new LowerError(`${who}: scans by a field that is not the grid's major key`);
      if (a.window && a.window.key === null) throw new LowerError(`${who}: the window must declare its segment ('∷ … by @key') to run one segment per thread`);
      if (a.window && a.window.key !== key) throw new LowerError(`${who}: windows by a field that is not the grid's major key carried through the stages before it`);
    }
    if (key !== null) key = carried(k, key);

    const args = stage.args.flat().map((a) => wgslExpr(a, P));
    const feeds = anyStmt(k.body, (s) => s.k === 'feed');
    // A tail feed (passes/tail.ts) is the loop's next turn. A kernel whose
    // every feed is one (ExpandSpans: `>> …; << …`) feeds at most once per
    // token, so it is a loop over one token, no worklist; several feeds in a
    // row (DecomposeBeziers) need the worklist, popped at the top of the loop
    // unless the last turn fed.
    const worklist = feeds && needsWorklist(k.body);
    out.feeds ||= worklist;
    const w = k.inputWidth;
    const env: WgslEnv = {
      param: (i) => args[i],
      state: (i) => `S${j}[${i}]`,
      input: (i) => (feeds ? `T${j}[${i}u]` : `a${i}`),
      emit: (vals, ind) => (j + 1 < stages.length ? `${ind}${call(j + 1, vals)}` : o.sink.emit(vals, ind)),
      feed: (vals, ind, tail) => (tail ? again(j, vals, ind) : push(j, w, o.cap, vals, ind)),
    };
    out.decls.push(`var<private> S${j} : array<f32, ${Math.max(1, k.stateInit.length)}>;`);
    k.stateInit.forEach((e, i) => out.init.push(`  S${j}[${i}] = ${wgslExpr(e, env)};`));
    const params = Array.from({ length: w }, (_, i) => `a${i} : f32`).join(', ');
    if (feeds && !worklist) {
      fns.push([
        `fn st${j}(${params}) {`,
        `  var T${j} : array<f32, ${w}>;`,
        ...Array.from({ length: w }, (_, i) => `  T${j}[${i}] = a${i};`),
        `  var again = false;`,
        `  var guard = 0u;`,
        `  loop {`,
        `    if (guard > 1000000u) { break; }`,
        `    guard += 1u;`,
        wgslBody(k.body, '    ', env),
        `    break;`,
        `  }`,
        `}`,
      ].join('\n'));
    } else if (feeds) {
      out.decls.push(`var<private> F${j} : array<f32, ${o.cap * w}>;`, `var<private> sp${j} : u32;`);
      out.init.push(`  sp${j} = 0u;`);
      fns.push([
        `fn st${j}(${params}) {`,
        push(j, w, o.cap, Array.from({ length: w }, (_, i) => `a${i}`), '  '),
        `  var T${j} : array<f32, ${w}>;`,
        `  var again = false;`,
        `  var guard = 0u;`,
        `  loop {`,
        `    if (guard > 1000000u) { break; }`,
        `    guard += 1u;`,
        `    if (!again) {`,
        `      if (sp${j} == 0u) { break; }`,
        `      sp${j} -= 1u;`,
        `      for (var k = 0u; k < ${w}u; k += 1u) { T${j}[k] = F${j}[sp${j} * ${w}u + k]; }`,
        `    }`,
        `    again = false;`,
        wgslBody(k.body, '    ', env),
        `  }`,
        `}`,
      ].join('\n'));
    } else {
      fns.push(`fn st${j}(${params}) {\n${wgslBody(k.body, '  ', env)}\n}`);
    }
    if (k.epilogue.length > 0) {
      out.fns.push(`fn fl${j}() {\n${wgslBody(k.epilogue, '  ', { ...env, input: () => fail('input in a flush body') })}\n}`);
      out.flush.push(`  fl${j}();`);
    }
  });
  // Callees before callers: st{m-1} first. Flush bodies call st{j+1}, so
  // they come after every stage.
  out.fns.unshift(...fns.reverse());
  return out;
}

const fail = (what: string): never => {
  throw new LowerError(`${what} has no meaning here`);
};

// A tail feed: the values first (they read T), then T; then round again.
// (`again` is only read by a worklist loop, which must not pop that turn.)
// The temporaries are next0, next1, …: not f0, f1, …, since f16 and f32 are
// WGSL's own words, and a 49-field patch has an f16.
function again(j: number, vals: string[], ind: string): string {
  return [
    `${ind}{`,
    ...vals.map((v, i) => `${ind}  let next${i} = ${v};`),
    ...vals.map((_, i) => `${ind}  T${j}[${i}] = next${i};`),
    `${ind}  again = true;`,
    `${ind}  continue;`,
    `${ind}}`,
  ].join('\n');
}

// Push a token onto stage j's worklist; a full one sets OVERFLOW (never hangs).
function push(j: number, w: number, cap: number, vals: string[], ind: string): string {
  return [
    `${ind}if (sp${j} < ${cap}u) {`,
    ...vals.map((v, i) => `${ind}  F${j}[sp${j} * ${w}u + ${i}u] = ${v};`),
    `${ind}  sp${j} += 1u;`,
    `${ind}} else {`,
    `${ind}  atomicStore(&OVERFLOW, 1u);`,
    `${ind}}`,
  ].join('\n');
}

// --- the two pass shapes ----------------------------------------------------

const PARAMS: Binding = { name: 'P', role: 'params', access: 'read', type: 'array<f32>' };
const OVERFLOW: Binding = { name: 'OVERFLOW', role: 'overflow', access: 'read_write', type: 'atomic<u32>' };

function shader(title: string, bindings: Binding[], s: Stages, main: string[]): string {
  const decl = (b: Binding, i: number) =>
    `@group(0) @binding(${i}) var<${b.access === 'uniform' ? 'uniform' : `storage, ${b.access}`}> ${b.name} : ${b.type};`;
  return [
    `// ${title}`,
    META_WGSL,
    ...bindings.map(decl),
    ...s.decls,
    ...s.fns,
    `@compute @workgroup_size(${WORKGROUP_SIZE})`,
    `fn main(@builtin(global_invocation_id) gid : vec3<u32>) {`,
    ...main,
    `}`,
  ].filter((l) => l !== '').join('\n') + '\n';
}

// One thread per input token.
function tokensPass(width: number, stages: FusedStage[], o: PassOptions): Pass {
  const s = genStages(stages, width, o, null);
  const INBUF: Binding = { name: 'INBUF', role: 'input', access: 'read', type: 'array<f32>' };
  const bindings = [META, INBUF, ...(o.paramWidth > 0 ? [PARAMS] : []), ...(s.feeds ? [OVERFLOW] : []), ...o.sink.bindings];
  const names = stages.map((st) => st.name).join(' → ') || '(→)';
  const main = [
    `  let i = gid.x;`,
    `  if (i >= META.n) { return; }`,
    ...s.init,
    `  st0(${Array.from({ length: width }, (_, k) => `INBUF[i * ${width}u + ${k}u]`).join(', ')});`,
  ];
  return { name: names, over: 'tokens', bindings, wgsl: shader(`${names}, one thread per token (generated from Nile IR)`, bindings, s, main) };
}

// One thread per major-key bucket, walking the minor key.
function segmentsPass(g: Grid, stages: FusedStage[], o: PassOptions): Pass {
  const s = genStages(stages, g.width, o, g.keys[0]);
  const reads = g.fields.map((f): Binding => ({ name: f.grid, role: 'grid', access: 'read', type: 'array<i32>' }));
  const bindings = [META, ...(o.paramWidth > 0 ? [PARAMS] : []), ...reads, ...(s.feeds ? [OVERFLOW] : []), ...o.sink.bindings];
  const names = stages.map((st) => st.name).join(' → ') || '(→)';
  const slot = (i: number): string => {
    const f = g.fields.find((x) => x.index === i);
    if (f) return `f32(${f.grid}[gi]) / ${FIXED_SCALE}.0`;
    return g.keys[0] === i ? 'f32(seg) + 0.5' : 'f32(m) + 0.5';
  };
  const main = [
    `  let seg = gid.x + META.segBase;`,
    `  if (seg >= META.segEnd) { return; }`,
    ...s.init,
    `  for (var m = META.minBase; m < META.minEnd; m += 1u) {`,
    `    let gi = seg * META.minor + m;`,
    `    st0(${Array.from({ length: g.width }, (_, i) => slot(i)).join(', ')});`,
    `  }`,
    ...s.flush,
  ];
  return { name: names, over: 'segments', bindings, wgsl: shader(`${names}, one thread per segment of the grid (generated from Nile IR)`, bindings, s, main) };
}

// The sink between a kernels pass and its grid: keys address a cell, reduced
// fields are added in fixed point. Writes outside the band are dropped.
function gridSink(g: Grid): Sink {
  const two = g.keys.length === 2;
  return {
    bindings: g.fields.map((f) => ({ name: f.grid, role: 'grid', access: 'read_write', type: 'array<atomic<i32>>' })),
    emit: (vals, ind) => [
      `${ind}{`,
      `${ind}  let k0 = i32(floor(${vals[g.keys[0]]}));`,
      two ? `${ind}  let k1 = i32(floor(${vals[g.keys[1]]}));` : `${ind}  let k1 = 0;`,
      `${ind}  if (k0 >= i32(META.segBase) && k0 < i32(META.segEnd) && k1 >= 0 && k1 < i32(META.minor)) {`,
      `${ind}    let gi = u32(k0) * META.minor + u32(k1);`,
      ...g.fields.map((f) => `${ind}    atomicAdd(&${f.grid}[gi], i32(round(${vals[f.index]} * ${FIXED_SCALE}.0)));`),
      `${ind}  }`,
      `${ind}}`,
    ].join('\n'),
  };
}
