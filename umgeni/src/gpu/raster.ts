// The readback hosts: run a plan over the whole grid in one submission and
// read its sink back — one fence, for tests and benchmarks that compare the
// GPU with the CPU. createRasterHost reads a coverage image (execute.ts's
// coverageSink) and can be run again; readAppended reads appended tokens
// (appendSink) once. Order-independence (atomic accumulation instead of a sorted
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

// Run a plan whose sink appends tokens, over the whole grid, and read them
// back. Threads finish in any order, so the tokens come back as a multiset.
// `cap`: the most tokens the sink may append.
export async function readAppended(device: GPUDevice, plan: Plan, tokens: number[][], width: number, cap: number): Promise<number[][]> {
  const x = createExecutor(device, plan);
  const outBytes = cap * width * 4;
  const meta = device.createBuffer({ size: META_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const input = device.createBuffer({ size: Math.max(16, tokens.length * plan.inputWidth * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const out = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const count = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const readBuf = device.createBuffer({ size: outBytes + 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(meta, 0, metaWords(tokens.length, plan.extent, wholeGrid(plan.extent)));
  device.queue.writeBuffer(input, 0, new Float32Array(tokens.flat()));
  const groups = x.bind({ meta, input, sink: { OUT: out, COUNT: count } });
  const enc = device.createCommandEncoder();
  x.clearGrids(enc, 0, plan.cells);
  enc.clearBuffer(count);
  enc.clearBuffer(x.overflow);
  x.encode(enc, groups, { n: tokens.length, segments: plan.extent[0] });
  enc.copyBufferToBuffer(out, 0, readBuf, 0, outBytes);
  enc.copyBufferToBuffer(count, 0, readBuf, outBytes, 4);
  enc.copyBufferToBuffer(x.overflow, 0, readBuf, outBytes + 4, 4);
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const mapped = readBuf.getMappedRange();
  const [got, overflowed] = new Uint32Array(mapped.slice(outBytes, outBytes + 8));
  if (overflowed) throw new Error(`'${plan.name}': a thread overflowed its worklist, so the tokens are incomplete`);
  if (got > cap) throw new Error(`'${plan.name}' appended ${got} tokens, more than the ${cap} the buffer holds`);
  const vals = new Float32Array(mapped.slice(0, got * width * 4));
  readBuf.unmap();
  const result: number[][] = [];
  for (let i = 0; i < got; i++) result.push(Array.from(vals.subarray(i * width, i * width + width)));
  for (const b of [meta, input, out, count, readBuf]) b.destroy();
  x.dispose();
  return result;
}
