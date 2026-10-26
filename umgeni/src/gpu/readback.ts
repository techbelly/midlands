// Readback: run a plan over the whole grid in one submission and read its
// sink back — one fence, for tests and benchmarks that compare the GPU with
// the CPU. One host per sink: createCoverageReadback for coverageSink, run
// again and again; readAppended for appendSink, once. Order-independence
// (atomic accumulation instead of a sorted stream) is licensed by the
// source's GroupBy/ReduceBy declarations; float rounding differs (16.16
// atomics + f32), so comparisons use tolerances.

import { createExecutor, type Executor } from './execute.js';
import { META_BYTES, metaWords, wholeGrid, type Plan } from './lower.js';

const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
const UNIFORM = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
const READ = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;

// One run over the whole grid, n tokens in: the grids and the `clears`
// cleared first (the sinks ACCUMULATE, so stale runs would ghost through),
// then the sinks copied out in order with the overflow word after them,
// mapped and returned as bytes. The one fence.
async function runWhole(device: GPUDevice, x: Executor, groups: GPUBindGroup[], n: number, clears: GPUBuffer[], sinks: { buf: GPUBuffer; bytes: number }[], readBuf: GPUBuffer): Promise<ArrayBuffer> {
  const { plan } = x;
  const enc = device.createCommandEncoder();
  x.clearGrids(enc, 0, plan.cells);
  for (const b of [...clears, x.overflow]) enc.clearBuffer(b);
  x.encode(enc, groups, { n, band: wholeGrid(plan.extent) });
  let at = 0;
  for (const s of [...sinks, { buf: x.overflow, bytes: 4 }]) {
    enc.copyBufferToBuffer(s.buf, 0, readBuf, at, s.bytes);
    at += s.bytes;
  }
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const bytes = readBuf.getMappedRange().slice(0);
  readBuf.unmap();
  return bytes;
}

export interface CoverageReadback {
  readonly plan: Plan;
  /** Rasterize a batch of tokens (n × plan.inputWidth floats) to a coverage
   *  buffer of the plan's extents (major × minor). One submission, one fence. */
  render(tokens: Float32Array<ArrayBuffer>, n: number): Promise<Float32Array>;
  /** True if any thread overflowed its worklist last render. */
  overflowed(): boolean;
  dispose(): void;
}

// `params`: the pipeline's parameters, flat, when it has any.
export function createCoverageReadback(device: GPUDevice, plan: Plan, params: number[] = []): CoverageReadback {
  const x = createExecutor(device, plan);
  const covBytes = plan.cells * 4;
  const meta = device.createBuffer({ size: META_BYTES, usage: UNIFORM });
  if (params.length !== plan.paramWidth) throw new Error(`'${plan.name}' takes ${plan.paramWidth} parameter values, given ${params.length}`);
  const P = plan.paramWidth > 0 ? device.createBuffer({ size: plan.paramWidth * 4, usage: STORAGE }) : undefined;
  if (P) device.queue.writeBuffer(P, 0, new Float32Array(params));
  const cov = device.createBuffer({ size: covBytes, usage: STORAGE });
  const readBuf = device.createBuffer({ size: covBytes + 4, usage: READ });
  let lastOverflow = false;

  let capacity = 0;
  let input: GPUBuffer | null = null;
  let groups: GPUBindGroup[] = [];
  function ensure(n: number): void {
    if (n <= capacity) return;
    capacity = Math.max(n, capacity * 2, 1024);
    input?.destroy();
    input = device.createBuffer({ size: capacity * plan.inputWidth * 4, usage: STORAGE });
    groups = x.bind({ meta, input, params: P, sink: { COV: cov } });
  }

  return {
    plan,
    overflowed: () => lastOverflow,
    async render(tokens, n) {
      ensure(n);
      device.queue.writeBuffer(meta, 0, metaWords(n, plan.extent, wholeGrid(plan.extent)));
      device.queue.writeBuffer(input!, 0, tokens, 0, n * plan.inputWidth);
      const bytes = await runWhole(device, x, groups, n, [cov], [{ buf: cov, bytes: covBytes }], readBuf);
      lastOverflow = new Uint32Array(bytes, covBytes, 1)[0] !== 0;
      return new Float32Array(bytes, 0, plan.cells);
    },
    dispose() {
      for (const b of [meta, cov, readBuf, input, P]) b?.destroy();
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
  const meta = device.createBuffer({ size: META_BYTES, usage: UNIFORM });
  const input = device.createBuffer({ size: Math.max(16, tokens.length * plan.inputWidth * 4), usage: STORAGE });
  const out = device.createBuffer({ size: outBytes, usage: STORAGE });
  const count = device.createBuffer({ size: 4, usage: STORAGE });
  const readBuf = device.createBuffer({ size: outBytes + 8, usage: READ });
  device.queue.writeBuffer(meta, 0, metaWords(tokens.length, plan.extent, wholeGrid(plan.extent)));
  device.queue.writeBuffer(input, 0, new Float32Array(tokens.flat()));
  const groups = x.bind({ meta, input, sink: { OUT: out, COUNT: count } });
  const bytes = await runWhole(device, x, groups, tokens.length, [count], [{ buf: out, bytes: outBytes }, { buf: count, bytes: 4 }], readBuf);
  const [got, overflowed] = new Uint32Array(bytes, outBytes, 2);
  if (overflowed) throw new Error(`'${plan.name}': a thread overflowed its worklist, so the tokens are incomplete`);
  if (got > cap) throw new Error(`'${plan.name}' appended ${got} tokens, more than the ${cap} the buffer holds`);
  const vals = new Float32Array(bytes, 0, got * width);
  const result: number[][] = [];
  for (let i = 0; i < got; i++) result.push(Array.from(vals.subarray(i * width, i * width + width)));
  for (const b of [meta, input, out, count, readBuf]) b.destroy();
  x.dispose();
  return result;
}
