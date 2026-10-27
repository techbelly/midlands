// Running a plan (lower.ts): buffers by role, a bind group per pass, and the
// dispatches, plus the two sinks a host can give the lowering for the
// pipeline's final emits. Nothing here knows which Nile it is running.

import { bandSegments, META_BYTES, type Band, type Binding, type Plan, type Sink } from './lower.js';
import { WORKGROUP_SIZE } from './wgsl.js';

// The host's buffers for a dispatch. `inputSize` bounds the input's dynamic
// binding (every offset binds this many bytes).
export interface Resources {
  meta: GPUBuffer;
  input?: GPUBuffer;
  inputSize?: number;
  params?: GPUBuffer;
  sink: Record<string, GPUBuffer>;
}

// One dispatch of the plan: n input tokens, over a band of the grid (the
// same band META was written with), with META and INBUF at these offsets
// when the executor binds them dynamically.
export interface Dispatch {
  n: number;
  band: Band;
  metaOffset?: number;
  inputOffset?: number;
}

export interface Executor {
  readonly plan: Plan;
  readonly grids: GPUBuffer[]; // plan.grids, cells × 4 bytes each
  readonly overflow: GPUBuffer;
  bind(res: Resources): GPUBindGroup[];
  encode(enc: GPUCommandEncoder, groups: GPUBindGroup[], dispatch: Dispatch): void;
  /** Clear the grids' cells [from, from + count). */
  clearGrids(enc: GPUCommandEncoder, from: number, count: number): void;
  dispose(): void;
}

// `dynamic`: META and INBUF bind with per-dispatch offsets (a presenter encoding
// many paths into one submission); otherwise they bind whole.
export function createExecutor(device: GPUDevice, plan: Plan, opts: { dynamic?: boolean } = {}): Executor {
  const dynamic = opts.dynamic ?? false;
  const isDynamic = (b: Binding) => dynamic && (b.role === 'meta' || b.role === 'input');
  const layouts = plan.passes.map((p) =>
    device.createBindGroupLayout({
      entries: p.bindings.map((b, i) => ({
        binding: i,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: b.access === 'uniform' ? 'uniform' : b.access === 'read' ? 'read-only-storage' : 'storage',
          hasDynamicOffset: isDynamic(b),
        },
      })),
    }));
  const pipelines = plan.passes.map((p, i) =>
    device.createComputePipeline({
      label: p.name,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts[i]] }),
      compute: { module: device.createShaderModule({ code: p.wgsl, label: p.name }), entryPoint: 'main' },
    }));
  const gridBytes = plan.cells * 4;
  const grids = plan.grids.map(() => device.createBuffer({ size: gridBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  const overflow = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const gridOf = new Map(plan.grids.map((g, i) => [g, grids[i]]));

  return {
    plan,
    grids,
    overflow,
    bind(res) {
      const resource = (b: Binding): GPUBindingResource => {
        switch (b.role) {
          case 'meta': return { buffer: res.meta, ...(dynamic ? { size: META_BYTES } : {}) };
          case 'input': return { buffer: must(res.input, 'input'), ...(dynamic ? { size: res.inputSize } : {}) };
          case 'params': return { buffer: must(res.params, 'params') };
          case 'grid': return { buffer: must(gridOf.get(b.name), b.name) };
          case 'overflow': return { buffer: overflow };
          case 'sink': return { buffer: must(res.sink[b.name], `sink buffer ${b.name}`) };
        }
      };
      return plan.passes.map((p, i) =>
        device.createBindGroup({ layout: layouts[i], entries: p.bindings.map((b, j) => ({ binding: j, resource: resource(b) })) }));
    },
    encode(enc, groups, d) {
      plan.passes.forEach((p, i) => {
        const offsets = p.bindings.filter(isDynamic).map((b) => (b.role === 'meta' ? d.metaOffset ?? 0 : d.inputOffset ?? 0));
        const threads = p.over === 'tokens' ? d.n : bandSegments(d.band);
        if (threads === 0) return;
        const pass = enc.beginComputePass({ label: p.name });
        pass.setPipeline(pipelines[i]);
        pass.setBindGroup(0, groups[i], offsets);
        pass.dispatchWorkgroups(Math.ceil(threads / WORKGROUP_SIZE));
        pass.end();
      });
    },
    clearGrids(enc, from, count) {
      for (const g of grids) enc.clearBuffer(g, from * 4, count * 4);
    },
    dispose() {
      for (const b of [...grids, overflow]) b.destroy();
    },
  };
}

const must = <T>(x: T | undefined, what: string): T => {
  if (x === undefined) throw new Error(`the plan needs a ${what} buffer`);
  return x;
};

// --- sinks ---------------------------------------------------------------------

// Coverage points (x, y, c, …), one pixel each, into a coverage image.
export const coverageSink: Sink = {
  bindings: [{ name: 'COV', role: 'sink', access: 'read_write', type: 'array<f32>' }],
  emit: (vals, ind) => [
    `${ind}{`,
    `${ind}  let px = i32(floor(${vals[0]}));`,
    `${ind}  let py = i32(floor(${vals[1]}));`,
    `${ind}  if (px >= 0 && px < i32(META.minor) && py >= 0 && py < i32(META.major)) {`,
    `${ind}    let ci = u32(py) * META.minor + u32(px);`,
    `${ind}    COV[ci] = min(COV[ci] + ${vals[2]}, 1.0);`,
    `${ind}  }`,
    `${ind}}`,
  ].join('\n'),
};

// Tokens appended to OUT, in whatever order threads finish (the CPU's .run()
// output, as a multiset); COUNT says how many. A full OUT drops the rest.
export const appendSink = (width: number): Sink => ({
  bindings: [
    { name: 'OUT', role: 'sink', access: 'read_write', type: 'array<f32>' },
    { name: 'COUNT', role: 'sink', access: 'read_write', type: 'atomic<u32>' },
  ],
  emit: (vals, ind) => [
    `${ind}{`,
    `${ind}  let slot = atomicAdd(&COUNT, 1u);`,
    `${ind}  if ((slot + 1u) * ${width}u <= arrayLength(&OUT)) {`,
    ...vals.map((v, i) => `${ind}    OUT[slot * ${width}u + ${i}u] = ${v};`),
    `${ind}  }`,
    `${ind}}`,
  ].join('\n'),
});

