// WebGPU host runtime for map-class kernels (Phase A of the GPU backend).
//
// The streaming API inverts at this boundary: the GPU wants batches, so the
// caller accumulates tokens into a flat Float32Array (the token layout is
// already flat — scalarization pays off here) and gets the whole output
// batch back. Buffers are grown once and reused, so steady-state timing
// reflects dispatch + transfer, not allocation.

import type { KernelIR } from '../ir.js';
import { evalStateInit } from './eval.js';
import { genMapShader, WORKGROUP_SIZE } from './wgsl.js';
import { isMapKernel } from './classify.js';

export async function requestDevice(): Promise<GPUDevice | null> {
  const gpu = (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  return adapter.requestDevice();
}

export interface GpuMapKernel {
  readonly shader: string;
  /** Run a batch: `input` holds n×inputWidth floats; resolves to n×outputWidth. */
  run(input: Float32Array<ArrayBuffer>, n: number): Promise<Float32Array>;
  dispose(): void;
}

export function createGpuMapKernel(
  device: GPUDevice,
  kernel: KernelIR,
  params: number[] = [],
): GpuMapKernel {
  if (!isMapKernel(kernel)) {
    throw new Error(`'${kernel.name}' is not a map-class kernel (Phase A supports only those)`);
  }
  const shader = genMapShader(kernel);
  const module = device.createShaderModule({ code: shader, label: kernel.name });
  const pipeline = device.createComputePipeline({
    label: kernel.name,
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  // Params + folded state (never zero-sized: bindings require length > 0).
  const state = evalStateInit(kernel.stateInit, params);
  const pData = new Float32Array([...params, ...state, 0]);
  const pBuf = device.createBuffer({ size: pData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(pBuf, 0, pData);
  const metaBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  let capacity = 0;
  let inBuf: GPUBuffer | null = null;
  let outBuf: GPUBuffer | null = null;
  let readBuf: GPUBuffer | null = null;
  let bindGroup: GPUBindGroup | null = null;

  function ensure(n: number): void {
    if (n <= capacity) return;
    capacity = Math.max(n, capacity * 2, 1024);
    inBuf?.destroy();
    outBuf?.destroy();
    readBuf?.destroy();
    inBuf = device.createBuffer({
      size: capacity * kernel.inputWidth * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    outBuf = device.createBuffer({
      size: capacity * kernel.outputWidth * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    readBuf = device.createBuffer({
      size: capacity * kernel.outputWidth * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: metaBuf } },
        { binding: 1, resource: { buffer: pBuf } },
        { binding: 2, resource: { buffer: inBuf } },
        { binding: 3, resource: { buffer: outBuf } },
      ],
    });
  }

  return {
    shader,
    async run(input, n) {
      ensure(n);
      device.queue.writeBuffer(metaBuf, 0, new Uint32Array([n]));
      device.queue.writeBuffer(inBuf!, 0, input, 0, n * kernel.inputWidth);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup!);
      pass.dispatchWorkgroups(Math.ceil(n / WORKGROUP_SIZE));
      pass.end();
      enc.copyBufferToBuffer(outBuf!, 0, readBuf!, 0, n * kernel.outputWidth * 4);
      device.queue.submit([enc.finish()]);
      await readBuf!.mapAsync(GPUMapMode.READ, 0, n * kernel.outputWidth * 4);
      const out = new Float32Array(readBuf!.getMappedRange(0, n * kernel.outputWidth * 4).slice(0));
      readBuf!.unmap();
      return out;
    },
    dispose() {
      inBuf?.destroy();
      outBuf?.destroy();
      readBuf?.destroy();
      pBuf.destroy();
      metaBuf.destroy();
    },
  };
}
