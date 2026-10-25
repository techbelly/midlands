// The readback host: run a plan whose sink is a coverage image (execute.ts's
// coverageSink) over the whole grid in one submission, and read
// the coverage back — one fence, for tests and benchmarks that compare it
// with the CPU. Order-independence (atomic accumulation instead of a sorted
// stream) is licensed by the source's GroupBy/ReduceBy declarations; float
// rounding differs (16.16 atomics + f32), so comparisons use tolerances.

import { createExecutor, metaWords, wholeGrid } from './execute.js';
import { META_BYTES, type Plan } from './lower.js';

export interface GpuRasterizer {
  readonly plan: Plan;
  /** Rasterize a batch of tokens (n × plan.inputWidth floats) to a coverage
   *  buffer of the plan's extents (major × minor). One submission, one fence. */
  render(tokens: Float32Array<ArrayBuffer>, n: number): Promise<Float32Array>;
  /** True if any thread overflowed its worklist last render. */
  overflowed(): boolean;
  dispose(): void;
}

// `params`: the pipeline's parameters, flat, when it has any.
export function createRasterHost(device: GPUDevice, plan: Plan, params: number[] = []): GpuRasterizer {
  const x = createExecutor(device, plan);
  const covBytes = plan.cells * 4;
  const meta = device.createBuffer({ size: META_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  if (params.length !== plan.paramWidth) throw new Error(`'${plan.name}' takes ${plan.paramWidth} parameter values, given ${params.length}`);
  const P = plan.paramWidth > 0 ? device.createBuffer({ size: plan.paramWidth * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }) : undefined;
  if (P) device.queue.writeBuffer(P, 0, new Float32Array(params));
  // COPY_DST: cleared every frame — the sinks ACCUMULATE into coverage, so
  // stale frames would ghost through otherwise.
  const cov = device.createBuffer({ size: covBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const readCov = device.createBuffer({ size: covBytes + 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  let lastOverflow = false;

  let capacity = 0;
  let input: GPUBuffer | null = null;
  let groups: GPUBindGroup[] = [];
  function ensure(n: number): void {
    if (n <= capacity) return;
    capacity = Math.max(n, capacity * 2, 1024);
    input?.destroy();
    input = device.createBuffer({ size: capacity * plan.inputWidth * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    groups = x.bind({ meta, input, params: P, sink: { COV: cov } });
  }

  return {
    plan,
    overflowed: () => lastOverflow,
    async render(tokens, n) {
      ensure(n);
      device.queue.writeBuffer(meta, 0, metaWords(n, plan.extent, wholeGrid(plan.extent)));
      device.queue.writeBuffer(input!, 0, tokens, 0, n * plan.inputWidth);
      const enc = device.createCommandEncoder();
      x.clearGrids(enc, 0, plan.cells);
      enc.clearBuffer(cov);
      enc.clearBuffer(x.overflow);
      x.encode(enc, groups, { n, segments: plan.extent[0] });
      enc.copyBufferToBuffer(cov, 0, readCov, 0, covBytes);
      enc.copyBufferToBuffer(x.overflow, 0, readCov, covBytes, 4);
      device.queue.submit([enc.finish()]);
      await readCov.mapAsync(GPUMapMode.READ); // the single fence
      const mapped = readCov.getMappedRange();
      const out = new Float32Array(mapped.slice(0, covBytes));
      lastOverflow = new Uint32Array(mapped.slice(covBytes, covBytes + 4))[0] !== 0;
      readCov.unmap();
      return out;
    },
    dispose() {
      for (const b of [meta, cov, readCov, input, P]) b?.destroy();
      x.dispose();
    },
  };
}
