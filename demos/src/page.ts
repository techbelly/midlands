// What the pages share: one GPU device per page, asked for on first use and
// remembered (null where there is no WebGPU); a canvas configured to show
// it, once; something built on the GPU for a key and rebuilt when the key
// changes; showing one canvas of several; and a white page to draw on.

import { requestDevice } from '../../umgeni/src/gpu/device.js';

let device: Promise<GPUDevice | null> | null = null;
export const gpuDevice = (): Promise<GPUDevice | null> => (device ??= requestDevice());

export interface GpuCanvas {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}
const configured = new WeakMap<HTMLCanvasElement, GpuCanvas>();
export function configureCanvas(device: GPUDevice, canvas: HTMLCanvasElement): GpuCanvas | null {
  const had = configured.get(canvas);
  if (had?.device === device) return had;
  const context = canvas.getContext('webgpu');
  if (!context) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  const gc = { device, context, format };
  configured.set(canvas, gc);
  return gc;
}

// Something built on the GPU for a key, such as a presenter for a size:
// built on first use, kept while the key is the same, disposed and built
// again when it changes. Null, once and for good, where there is no WebGPU
// device or the build says it cannot (a canvas without a WebGPU context).
// The key is compared by its JSON.
export function gpuBuilt<K, T extends { dispose(): void }>(build: (device: GPUDevice, key: K) => T | null): (key: K) => Promise<T | null> {
  let have: { key: string; value: T } | null = null;
  let unavailable = false;
  return async (key) => {
    if (unavailable) return null;
    const k = JSON.stringify(key);
    if (have && have.key !== k) {
      have.value.dispose();
      have = null;
    }
    if (!have) {
      const device = await gpuDevice();
      const value = device && build(device, key);
      if (!value) {
        unavailable = true;
        return null;
      }
      have = { key: k, value };
    }
    return have.value;
  };
}

export function showOnly(shown: HTMLElement, ...all: HTMLElement[]): void {
  for (const el of all) el.style.display = el === shown ? '' : 'none';
}

// A white page the size of the canvas, for the CPU to paint into.
export function whitePage(ctx: CanvasRenderingContext2D, width: number, height: number): ImageData {
  const img = ctx.createImageData(width, height);
  img.data.fill(255);
  return img;
}
