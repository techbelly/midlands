// Phase A GPU benchmark: the CPU/GPU boundary, measured honestly.
//
// Runs TransformBeziers (the map-class stage of the text/tiger pipelines)
// over growing batch sizes: compiled-JS CPU path vs WebGPU round trip
// (upload + dispatch + readback) with reused buffers. The interesting output
// is not "which wins" but the crossover point and the fixed cost per round
// trip — the numbers Phase B planning needs.
//
// Run under Deno (WebGPU headless):
//   deno run --allow-read --unstable-sloppy-imports tools/bench-gpu.ts

import { readFileSync } from 'node:fs';
import { compileLibrary } from '../src/compile.js';
import { createGpuMapKernel, requestDevice } from '../src/gpu/runtime.js';
import { isMapKernel } from '../src/gpu/classify.js';

const dir = new URL('../test/fixtures/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, dir), 'utf8');
const library = compileLibrary([read('types.nl'), read('bezier.nl'), read('rasterize.nl')]);

// How much of the corpus Phase A covers, for honesty:
const kernels = library.ir.processes.filter((p) => p.k === 'kernel');
const maps = kernels.filter((k) => k.k === 'kernel' && isMapKernel(k));
console.log(`map-class kernels here: ${maps.map((k) => k.name).join(', ')} (${maps.length}/${kernels.length})`);

const M = [1.25, 0.1, -0.15, 1.1, 0.5, 0.25];
const WIDTH = 6;

function makeBatch(n: number): Float32Array {
  const a = new Float32Array(n * WIDTH);
  let s = 12345 >>> 0;
  for (let i = 0; i < a.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    a[i] = (s / 2 ** 32) * 100;
  }
  return a;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// CPU path: the compiled fused JS kernel, batch driven token by token
// (its native calling convention).
function cpuRun(input: Float32Array, n: number): Float64Array {
  const op = library.registry.get('TransformBeziers')!(M);
  const out = new Float64Array(n * WIDTH);
  let at = 0;
  op.setEmit((t) => {
    for (let i = 0; i < WIDTH; i++) out[at++] = t[i];
  });
  const token = new Array(WIDTH);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < WIDTH; j++) token[j] = input[i * WIDTH + j];
    op.push(token as number[]);
  }
  op.end();
  return out;
}

const device = await requestDevice();
if (!device) {
  console.error('No WebGPU device available.');
  Deno.exit(1);
}
const kernel = kernels.find((k) => k.name === 'TransformBeziers')!;
if (kernel.k !== 'kernel') throw new Error('unexpected');
const gpu = createGpuMapKernel(device, kernel, M);

// Correctness first (f32 vs f64: tolerance, not equality).
{
  const n = 1000;
  const batch = makeBatch(n);
  const cpuOut = cpuRun(batch, n);
  const gpuOut = await gpu.run(batch, n);
  let worst = 0;
  for (let i = 0; i < cpuOut.length; i++) {
    const err = Math.abs(gpuOut[i] - cpuOut[i]) / Math.max(1, Math.abs(cpuOut[i]));
    worst = Math.max(worst, err);
  }
  if (worst > 1e-5) throw new Error(`GPU output diverges: worst rel err ${worst}`);
  console.log(`correctness: ${n} tokens, worst relative error ${worst.toExponential(2)} (f32 vs f64)`);
}

console.log('\nbatch size | CPU ms  | GPU ms (round trip) | CPU Mtok/s | GPU Mtok/s');
console.log('-----------|---------|---------------------|------------|-----------');
for (const n of [2_000, 20_000, 200_000, 2_000_000]) {
  const batch = makeBatch(n);
  for (let i = 0; i < 3; i++) {
    cpuRun(batch, n);
    await gpu.run(batch, n);
  }
  const cpuTimes: number[] = [];
  const gpuTimes: number[] = [];
  for (let i = 0; i < 9; i++) {
    let t0 = performance.now();
    cpuRun(batch, n);
    cpuTimes.push(performance.now() - t0);
    t0 = performance.now();
    await gpu.run(batch, n);
    gpuTimes.push(performance.now() - t0);
  }
  const cpuMs = median(cpuTimes);
  const gpuMs = median(gpuTimes);
  console.log(
    `${String(n).padStart(10)} | ${cpuMs.toFixed(2).padStart(7)} | ${gpuMs.toFixed(2).padStart(19)} | ` +
    `${(n / cpuMs / 1000).toFixed(1).padStart(10)} | ${(n / gpuMs / 1000).toFixed(1).padStart(10)}`,
  );
}
gpu.dispose();
console.log('\n(2,191 tokens is one paragraph in the text demo.)');
