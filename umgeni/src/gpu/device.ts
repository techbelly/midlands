// The one WebGPU entry point every host shares: a device, or null where
// there is no WebGPU (an old browser, Node, a Deno without the flag).

export async function requestDevice(): Promise<GPUDevice | null> {
  const gpu = (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  return adapter.requestDevice();
}
