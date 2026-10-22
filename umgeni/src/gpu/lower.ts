// GPU lowering of access-pattern pipelines — the repayment of the
// hand-written resolve shader (docs/access-patterns.md).
//
// A fused pipeline of the shape
//
//   [feedback kernel]  →  GroupBy (@maj, @min)  →  ReduceBy (…; f ⊕ +, g ⊕ +)
//                      →  [scan kernel  →  window kernel]
//
// lowers to two generated passes:
//   pass A — the feedback kernel's body in a per-thread worklist; its emits
//     are routed by the GroupBy/ReduceBy declaration into fixed-point atomic
//     accumulation grids (commutative + on unordered groups is exactly what
//     licenses the atomics).
//   pass B — one thread per major-key segment (declared independent by the
//     scan's `by @maj`); the thread walks the minor axis re-running the scan
//     and window kernels' ALREADY-LOWERED sequential bodies, with their state
//     in thread-local arrays. Emitted spans accumulate into the coverage
//     image.
//
// v1 constraints (checked, with errors naming them):
//   - exactly one kernel before GroupBy; exactly [scan, window] after ReduceBy
//   - two grid keys, two reduce fields, both reduced with '+'
//   - token fields = keys ∪ reduce fields; keys are reconstructed as
//     bucket + 0.5 (the pixel-centre convention)
//   - the window kernel must declare its segment (`∷ … by @key`), and that
//     key must be the GroupBy major key carried through the scan kernel's
//     emit (checked structurally: the emit slot at the window's key offset
//     is a direct passthrough of the scan's key input). Segment-per-thread
//     execution is then exact, not assumed.

import type { FusedIR, KernelIR, ScalarExpr, StageIR } from '../ir.js';
import { wgslBody, WORKGROUP_SIZE, type WgslEnv } from './wgsl.js';
import type { RasterOptions } from './raster.js';

const FIXED_SCALE = 65536;

export class LowerError extends Error {}

interface Recognized {
  producer: KernelIR;
  layout: GridLayout;
  scanKernel: KernelIR;
  windowKernel: KernelIR;
}

function isAddOp(op: ScalarExpr): boolean {
  return op.k === 'bin' && op.op === 'add' && op.a.k === 'local' && op.b.k === 'local';
}

function findEmit(stmts: import('../ir.js').Stmt[]): { values: ScalarExpr[] } | null {
  for (const s of stmts) {
    if (s.k === 'emit') return s;
    if (s.k === 'if') {
      const hit = findEmit(s.then) ?? findEmit(s.else);
      if (hit) return hit;
    }
  }
  return null;
}

export function recognize(fused: FusedIR): Recognized {
  const segs = fused.segments;
  if (segs.length !== 4) {
    throw new LowerError(`'${fused.name}': expected kernel → GroupBy → ReduceBy → kernels, got ${segs.length} segments`);
  }
  const [pre, group, reduce, post] = segs;
  if (pre.k !== 'kernels' || pre.stages.length !== 1) {
    throw new LowerError(`'${fused.name}': expected exactly one kernel stage before GroupBy`);
  }
  if (group.k !== 'groupBy' || group.keyIndexes.length !== 2) {
    throw new LowerError(`'${fused.name}': expected GroupBy with two keys`);
  }
  if (group.stable) {
    throw new LowerError(`'${fused.name}': GroupBy stable cannot lower to atomic grids (order would matter)`);
  }
  if (reduce.k !== 'reduceBy' || reduce.fields.length !== 2 || !reduce.fields.every((f) => isAddOp(f.op))) {
    throw new LowerError(`'${fused.name}': expected ReduceBy with two '+'-reduced fields`);
  }
  if (post.k !== 'kernels' || post.stages.length !== 2) {
    throw new LowerError(`'${fused.name}': expected scan → window kernels after ReduceBy`);
  }
  const [scanStage, windowStage] = post.stages;
  const scanKernel = scanStage.kernel;
  const windowKernel = windowStage.kernel;
  if (!scanKernel.access?.scan) throw new LowerError(`'${scanStage.name}' does not declare a scan`);
  if (!windowKernel.access?.window) throw new LowerError(`'${windowStage.name}' does not declare windows`);
  const [majorKey, minorKey] = group.keyIndexes;
  if (scanKernel.access.scan.key !== majorKey) {
    throw new LowerError(`'${scanStage.name}' scans by a different key than GroupBy's major key`);
  }
  if (scanKernel.access.scan.op !== '+') {
    throw new LowerError(`'${scanStage.name}': only '+' scans lower so far`);
  }
  // Segment-per-thread execution is exact only if the window's segment key
  // is the scan's key, carried through the scan's emit unchanged.
  const windowKey = windowKernel.access.window.key;
  if (windowKey === null) {
    throw new LowerError(`'${windowStage.name}': the window must declare its segment ('∷ … by @key') to lower per-segment`);
  }
  const passthrough = findEmit(scanKernel.body)?.values[windowKey];
  if (!passthrough || passthrough.k !== 'input' || passthrough.index !== scanKernel.access.scan.key) {
    throw new LowerError(
      `'${windowStage.name}' segments by a field that is not '${scanStage.name}''s scan key passed through its emit`,
    );
  }
  const covered = new Set([majorKey, minorKey, reduce.fields[0].index, reduce.fields[1].index]);
  if (covered.size !== reduce.width) {
    throw new LowerError(`'${fused.name}': token fields must be exactly the keys plus the reduced fields`);
  }
  if (scanKernel.paramWidth > 0 || windowKernel.paramWidth > 0) {
    throw new LowerError(`'${fused.name}': parameterized scan/window kernels are not lowered yet`);
  }
  return {
    producer: pre.stages[0].kernel,
    layout: { majorKey, minorKey, fields: [reduce.fields[0].index, reduce.fields[1].index] },
    scanKernel,
    windowKernel,
  };
}

// State initializers in scan/window kernels are constants by construction
// (synthesized identities, zeros).
function constInit(e: ScalarExpr, who: string): number {
  if (e.k !== 'const') throw new LowerError(`'${who}': non-constant state initializer cannot lower yet`);
  return e.value;
}

export function genLoweredResolve(r: Recognized, width: number): string {
  const { scanKernel, windowKernel, layout } = r;
  const lines: string[] = [];
  lines.push(`// pass B generated from '${scanKernel.name}' (scan by key ${layout.majorKey}) and`);
  lines.push(`// '${windowKernel.name}' (window), lowered per major-key segment.`);
  lines.push(`// A caller dispatches a band of rows (rowBase up to height) and walks only\n// the columns colBase up to colEnd: outside a closed path's bounding box there\n// are no samples and the winding is zero, so nothing there is painted.`);
  lines.push(`struct Meta { n : u32, width : u32, height : u32, rowBase : u32, colBase : u32, colEnd : u32 }`);
  lines.push(`@group(0) @binding(0) var<uniform> META : Meta;`);
  lines.push(`@group(0) @binding(1) var<storage, read> GA : array<i32>;`);
  lines.push(`@group(0) @binding(2) var<storage, read> GH : array<i32>;`);
  lines.push(`@group(0) @binding(3) var<storage, read_write> COV : array<f32>;`);
  lines.push(``);
  lines.push(`@compute @workgroup_size(${WORKGROUP_SIZE})`);
  lines.push(`fn main(@builtin(global_invocation_id) gid : vec3<u32>) {`);
  lines.push(`  let y = gid.x + META.rowBase;`);
  lines.push(`  if (y >= META.height) { return; }`);

  // Thread-local state for both kernels.
  lines.push(`  var S1 : array<f32, ${Math.max(1, scanKernel.stateInit.length)}>;`);
  scanKernel.stateInit.forEach((e, i) => lines.push(`  S1[${i}] = ${wgslConst(constInit(e, scanKernel.name))};`));
  lines.push(`  var S2 : array<f32, ${Math.max(1, windowKernel.stateInit.length)}>;`);
  windowKernel.stateInit.forEach((e, i) => lines.push(`  S2[${i}] = ${wgslConst(constInit(e, windowKernel.name))};`));

  // The span sink: spans (x, y, c, l) accumulate into the coverage row.
  const sink = (vals: string[], ind: string): string =>
    [
      `${ind}{`,
      `${ind}  let sx = i32(floor(${vals[0]}));`,
      `${ind}  let sl = i32(round(${vals[3]}));`,
      `${ind}  let sc = ${vals[2]};`,
      `${ind}  for (var si = 0; si < sl; si += 1) {`,
      `${ind}    let px = sx + si;`,
      `${ind}    if (px >= 0 && px < i32(META.width)) {`,
      `${ind}      let ci = y * META.width + u32(px);`,
      `${ind}      COV[ci] = min(COV[ci] + sc, 1.0);`,
      `${ind}    }`,
      `${ind}  }`,
      `${ind}}`,
    ].join('\n');

  const windowEnv: WgslEnv = {
    param: () => { throw new LowerError('window kernels take no params here'); },
    state: (i) => `S2[${i}]`,
    input: (i) => `T2[${i}u]`,
    emit: sink,
    feed: () => { throw new LowerError('feeds cannot lower in a resolve pass'); },
    local: (n) => 'w' + n.replace(/[^A-Za-z0-9]/g, '_'),
  };
  const scanEnv: WgslEnv = {
    param: () => { throw new LowerError('scan kernels take no params here'); },
    state: (i) => `S1[${i}]`,
    input: (i) => `T1[${i}u]`,
    emit: (vals, ind) =>
      [
        `${ind}{`,
        `${ind}  var T2 : array<f32, ${windowKernel.inputWidth}>;`,
        ...vals.map((v, i) => `${ind}  T2[${i}] = ${v};`),
        wgslBody(windowKernel.body, `${ind}  `, windowEnv),
        `${ind}}`,
      ].join('\n'),
    feed: () => { throw new LowerError('feeds cannot lower in a resolve pass'); },
    local: (n) => 's' + n.replace(/[^A-Za-z0-9]/g, '_'),
  };

  // Walk the minor axis, reconstructing the reduced token from the grids:
  // keys as bucket + 0.5 (pixel centres), reduced fields from fixed point.
  lines.push(`  for (var xi = META.colBase; xi < META.colEnd; xi += 1u) {`);
  lines.push(`    let gi = y * META.width + xi;`);
  lines.push(`    var T1 : array<f32, ${scanKernel.inputWidth}>;`);
  lines.push(`    T1[${layout.minorKey}] = f32(xi) + 0.5;`);
  lines.push(`    T1[${layout.majorKey}] = f32(y) + 0.5;`);
  lines.push(`    T1[${layout.fields[0]}] = f32(GA[gi]) / ${FIXED_SCALE}.0;`);
  lines.push(`    T1[${layout.fields[1]}] = f32(GH[gi]) / ${FIXED_SCALE}.0;`);
  lines.push(wgslBody(scanKernel.body, '    ', scanEnv));
  lines.push(`  }`);
  // Flush: the scan kernel's epilogue (usually empty), then the window
  // kernel's (the ∅ arm).
  lines.push(wgslBody(scanKernel.epilogue, '  ', scanEnv));
  lines.push(wgslBody(windowKernel.epilogue, '  ', windowEnv));
  lines.push(`}`);
  lines.push(``);
  return lines.filter((l) => l !== '').join('\n');
}

function wgslConst(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

export interface LoweredShaders {
  decompose: string;
  resolve: string;
}

// The whole lowering: a fused access-patterns pipeline -> the two shaders.
// Every line of kernel logic in both is generated from Nile IR; the
// scaffolding (worklists, grids, the span sink) is the backend.
// --- pass A: the decompose kernel's body inside a per-thread worklist ---

// Which emitted-token slots address the grid and which accumulate into it —
// i.e. the GroupBy keys and the ReduceBy fields. The default matches
// EdgeSample rasterization: GroupBy (@y, @x), ReduceBy (a ⊕ +, h ⊕ +).
export interface GridLayout {
  majorKey: number; // grid row (y)
  minorKey: number; // grid column (x)
  fields: [number, number]; // accumulated into GA / GH
}
const EDGE_SAMPLE_LAYOUT: GridLayout = { majorKey: 1, minorKey: 0, fields: [2, 3] };

export function genDecomposeShader(k: KernelIR, o: RasterOptions, layout: GridLayout = EDGE_SAMPLE_LAYOUT): string {
  if (k.inputWidth !== 6 || k.stateInit.length > 0 || k.init.length > 0 || k.epilogue.length > 0 || k.paramWidth > 0) {
    throw new Error(`'${k.name}' does not have the decompose shape (Bezier >> samples, stateless, no params)`);
  }
  const cap = o.stackCap ?? 128;
  const env: WgslEnv = {
    // No P binding: WGSL auto layouts prune unused bindings, and a bind-group
    // entry for a pruned binding invalidates the whole submission.
    param: () => {
      throw new Error('decompose scaffold takes no params');
    },
    state: () => {
      throw new Error('decompose kernels are stateless');
    },
    input: (i) => `T[${i}u]`,
    emit: (vals, ind) =>
      [
        `${ind}{`,
        `${ind}  let ex = i32(floor(${vals[layout.minorKey]}));`,
        `${ind}  let ey = i32(floor(${vals[layout.majorKey]}));`,
        `${ind}  if (ex >= 0 && ex < i32(META.width) && ey >= 0 && ey < i32(META.height)) {`,
        `${ind}    let gi = u32(ey) * META.width + u32(ex);`,
        `${ind}    atomicAdd(&GA[gi], i32(round(${vals[layout.fields[0]]} * ${FIXED_SCALE}.0)));`,
        `${ind}    atomicAdd(&GH[gi], i32(round(${vals[layout.fields[1]]} * ${FIXED_SCALE}.0)));`,
        `${ind}  }`,
        `${ind}}`,
      ].join('\n'),
    feed: (vals, ind) =>
      [
        `${ind}if (sp < ${cap}u) {`,
        ...vals.map((v, i) => `${ind}  F[sp * 6u + ${i}u] = ${v};`),
        `${ind}  sp += 1u;`,
        `${ind}} else {`,
        `${ind}  atomicStore(&OVERFLOW, 1u);`,
        `${ind}}`,
      ].join('\n'),
  };
  return [
    `// pass A: ${k.name} (body generated from Nile IR) over a per-thread worklist,`,
    `// accumulating edge samples into fixed-point atomic grids.`,
    `struct Meta { n : u32, width : u32, height : u32 }`,
    `@group(0) @binding(0) var<uniform> META : Meta;`,
    `@group(0) @binding(1) var<storage, read> INBUF : array<f32>;`,
    `@group(0) @binding(2) var<storage, read_write> GA : array<atomic<i32>>;`,
    `@group(0) @binding(3) var<storage, read_write> GH : array<atomic<i32>>;`,
    `@group(0) @binding(4) var<storage, read_write> OVERFLOW : atomic<u32>;`,
    ``,
    `@compute @workgroup_size(${WORKGROUP_SIZE})`,
    `fn main(@builtin(global_invocation_id) gid : vec3<u32>) {`,
    `  let i = gid.x;`,
    `  if (i >= META.n) { return; }`,
    `  var F : array<f32, ${cap * 6}>;`,
    `  var T : array<f32, 6>;`,
    `  for (var k = 0u; k < 6u; k += 1u) { F[k] = INBUF[i * 6u + k]; }`,
    `  var sp : u32 = 1u;`,
    `  var guard : u32 = 0u;`,
    `  loop {`,
    `    if (sp == 0u || guard > 1000000u) { break; }`,
    `    guard += 1u;`,
    `    sp -= 1u;`,
    `    for (var k = 0u; k < 6u; k += 1u) { T[k] = F[sp * 6u + k]; }`,
    wgslBody(k.body, '    ', env),
    `  }`,
    `}`,
    ``,
  ].join('\n');
}

export function lowerFusedPipeline(fused: FusedIR, opts: RasterOptions): LoweredShaders {
  const r = recognize(fused);
  return {
    decompose: genDecomposeShader(r.producer, opts, r.layout),
    resolve: genLoweredResolve(r, opts.width),
  };
}
