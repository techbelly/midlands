// What the GPU pages share: one device per page, asked for on first use and
// remembered (null where there is no WebGPU); a canvas configured to show
// it; and showing one canvas of several.

import { requestDevice } from '../../umgeni/src/gpu/device.js';

let device: Promise<GPUDevice | null> | null = null;
export const gpuDevice = (): Promise<GPUDevice | null> => (device ??= requestDevice());

export interface GpuCanvas {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}
export function configureCanvas(device: GPUDevice, canvas: HTMLCanvasElement): GpuCanvas | null {
  const context = canvas.getContext('webgpu');
  if (!context) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  return { device, context, format };
}

export function showOnly(shown: HTMLElement, ...all: HTMLElement[]): void {
  for (const el of all) el.style.display = el === shown ? '' : 'none';
}
