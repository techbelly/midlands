// What the headless GPU checks share: a device or a plain refusal, a fused
// pipeline's coverage plan, an offscreen texture and its readback, and the
// comparisons with the CPU. Deno with WebGPU only; tsc skips demos/tools,
// so `deno check demos/tools/*.ts` is their typecheck.

import { requestDevice } from '../../umgeni/src/gpu/device.js';

export async function requireDevice(): Promise<GPUDevice> {
  const device = await requestDevice();
  if (!device) throw new Error('no WebGPU device');
  return device;
}

export { coveragePlan } from './gpu-scenarios.js';

// A W × H rgba texture the presenter can draw into and a check can read.
export const offscreenTexture = (device: GPUDevice, W: number, H: number): GPUTexture =>
  device.createTexture({
    size: { width: W, height: H },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

// The texture's pixels, packed W × H × rgba as ImageData lays them out (the
// copy needs 256-byte-aligned rows; the padding is stripped here). A fence,
// so checks only: the browser path has none.
export async function readTexture(device: GPUDevice, tex: GPUTexture, W: number, H: number): Promise<Uint8Array> {
  const rowBytes = Math.ceil((W * 4) / 256) * 256;
  const buf = device.createBuffer({ size: rowBytes * H, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: rowBytes }, { width: W, height: H });
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(buf.getMappedRange());
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) px.set(padded.subarray(y * rowBytes, y * rowBytes + W * 4), y * W * 4);
  buf.unmap();
  buf.destroy();
  return px;
}

export { coverageDiff } from './gpu-scenarios.js';

// Two rgba images, both packed as ImageData, compared on r, g and b: the
// largest and mean channel difference, how many pixels differ at all, how
// many differ by more than `farThan`, and how many are not white in each.
export function imageDiff(gpu: ArrayLike<number>, cpu: ArrayLike<number>, farThan = 48): { max: number; mean: number; differ: number; far: number; inked: { gpu: number; cpu: number } } {
  let max = 0;
  let sum = 0;
  let differ = 0;
  let far = 0;
  const inked = { gpu: 0, cpu: 0 };
  const white = (px: ArrayLike<number>, i: number) => px[i] === 255 && px[i + 1] === 255 && px[i + 2] === 255;
  for (let i = 0; i < cpu.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(gpu[i + k] - cpu[i + k]));
    max = Math.max(max, d);
    sum += d;
    if (d > 0) differ++;
    if (d > farThan) far++;
    if (!white(gpu, i)) inked.gpu++;
    if (!white(cpu, i)) inked.cpu++;
  }
  return { max, mean: sum / (cpu.length / 4), differ, far, inked };
}
