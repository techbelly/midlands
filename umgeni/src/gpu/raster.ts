// The GPU-resident rasterizer's verification host: run the two passes that
// gpu/lower.ts generates from Nile source (decompose into fixed-point atomic
// grids; per-scanline resolve to coverage) in ONE queue submission, and read
// the coverage back — one fence, for tests and benchmarks that compare it
// with the CPU. Order-independence (atomic accumulation instead of a sorted
// stream) is licensed by the source's GroupBy/ReduceBy declarations; float
// rounding differs (16.16 atomics + f32), so comparisons use tolerances.

import { WORKGROUP_SIZE } from './wgsl.js';

export interface GpuRasterizer {
  readonly decomposeShader: string;
  readonly resolveShader: string;
  /** Rasterize a batch of beziers (n×6 floats) to a width×height coverage
   *  buffer. One queue submission, one fence (the readback). */
  render(beziers: Float32Array<ArrayBuffer>, n: number): Promise<Float32Array>;
  /** True if any thread overflowed its worklist last render. */
  overflowed(): boolean;
  dispose(): void;
}

export interface RasterOptions {
  width: number;
  height: number;
  /** Per-thread worklist capacity (subdivision is depth-first, so this bounds
   *  pending siblings, not total work). Overflow sets a flag, never hangs. */
  stackCap?: number;
}

// The compute core (buffers, bind groups, pass encoding) for the readback
// host below. (Presentation — many paths, colours, textures, zero fences —
// is gpu/tiger.ts.)
export interface RasterCore {
  readonly width: number;
  readonly height: number;
  readonly covBuffer: GPUBuffer;
  readonly overflowBuffer: GPUBuffer;
  /** Queue the input writes for a frame (uploads; not a fence). */
  prepare(beziers: Float32Array<ArrayBuffer>, n: number): void;
  /** Encode the compute passes for the prepared frame. */
  encode(enc: GPUCommandEncoder, n: number): void;
  dispose(): void;
}

export function createRasterCore(
  device: GPUDevice,
  decomposeShader: string,
  resolveShader: string,
  opts: RasterOptions,
): RasterCore {
  const { width, height } = opts;

  const pipeA = device.createComputePipeline({
    label: 'decompose',
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: decomposeShader }), entryPoint: 'main' },
  });
  const pipeB = device.createComputePipeline({
    label: 'resolve',
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: resolveShader }), entryPoint: 'main' },
  });

  const gridBytes = width * height * 4;
  const meta = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const gridA = device.createBuffer({ size: gridBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const gridH = device.createBuffer({ size: gridBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const cov = device.createBuffer({
    size: gridBytes,
    // COPY_DST: cleared every frame — the lowered resolve ACCUMULATES spans
    // into coverage, so stale frames would ghost through otherwise.
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const overflow = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });

  const bindB = device.createBindGroup({
    layout: pipeB.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: meta } },
      { binding: 1, resource: { buffer: gridA } },
      { binding: 2, resource: { buffer: gridH } },
      { binding: 3, resource: { buffer: cov } },
    ],
  });

  let capacity = 0;
  let inBuf: GPUBuffer | null = null;
  let bindA: GPUBindGroup | null = null;

  function ensure(n: number): void {
    if (n <= capacity) return;
    capacity = Math.max(n, capacity * 2, 1024);
    inBuf?.destroy();
    inBuf = device.createBuffer({ size: capacity * 24, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    bindA = device.createBindGroup({
      layout: pipeA.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: meta } },
        { binding: 1, resource: { buffer: inBuf } },
        { binding: 2, resource: { buffer: gridA } },
        { binding: 3, resource: { buffer: gridH } },
        { binding: 4, resource: { buffer: overflow } },
      ],
    });
  }

  return {
    width,
    height,
    covBuffer: cov,
    overflowBuffer: overflow,
    prepare(beziers, n) {
      ensure(n);
      device.queue.writeBuffer(meta, 0, new Uint32Array([n, width, height, 0, 0, width])); // the whole frame
      device.queue.writeBuffer(inBuf!, 0, beziers, 0, n * 6);
    },
    encode(enc, n) {
      enc.clearBuffer(gridA);
      enc.clearBuffer(gridH);
      enc.clearBuffer(cov);
      enc.clearBuffer(overflow);
      let pass = enc.beginComputePass();
      pass.setPipeline(pipeA);
      pass.setBindGroup(0, bindA!);
      pass.dispatchWorkgroups(Math.ceil(n / WORKGROUP_SIZE));
      pass.end();
      pass = enc.beginComputePass();
      pass.setPipeline(pipeB);
      pass.setBindGroup(0, bindB);
      pass.dispatchWorkgroups(Math.ceil(height / WORKGROUP_SIZE));
      pass.end();
    },
    dispose() {
      for (const b of [meta, gridA, gridH, cov, overflow, inBuf]) b?.destroy();
    },
  };
}

// The host orchestration for the verify/benchmark path: run the core, copy
// coverage out, one fence (mapAsync) per render.
export function createRasterHost(
  device: GPUDevice,
  decomposeShader: string,
  resolveShader: string,
  opts: RasterOptions,
): GpuRasterizer {
  const core = createRasterCore(device, decomposeShader, resolveShader, opts);
  const gridBytes = core.width * core.height * 4;
  const readCov = device.createBuffer({ size: gridBytes + 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  let lastOverflow = false;

  return {
    decomposeShader,
    resolveShader,
    overflowed: () => lastOverflow,
    async render(beziers, n) {
      core.prepare(beziers, n);
      const enc = device.createCommandEncoder();
      core.encode(enc, n);
      enc.copyBufferToBuffer(core.covBuffer, 0, readCov, 0, gridBytes);
      enc.copyBufferToBuffer(core.overflowBuffer, 0, readCov, gridBytes, 4);
      device.queue.submit([enc.finish()]);
      await readCov.mapAsync(GPUMapMode.READ); // the single fence
      const mapped = readCov.getMappedRange();
      const out = new Float32Array(mapped.slice(0, gridBytes));
      lastOverflow = new Uint32Array(mapped.slice(gridBytes, gridBytes + 4))[0] !== 0;
      readCov.unmap();
      return out;
    },
    dispose() {
      readCov.destroy();
      core.dispose();
    },
  };
}
