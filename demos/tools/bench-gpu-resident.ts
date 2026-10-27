// The GPU-resident rasterizer vs the CPU reference, on real text.
//
// Both sides share the CPU front half (layout → transform → clip, compiled
// from Nile). The back half — decompose → sort → combine → paint on CPU;
// decompose → grid → resolve on GPU, both shaders generated from
// RasterizeParallel's IR — is what's compared: max pixel difference (tolerance:
// fixed-point atomics + f32) and wall time with a single fence per frame.
//
// Run: npm run bench:gpu:resident   (Deno; panics at exit — wgpu teardown bug)

import { PARAGRAPH, median } from './bench-text.js';
import { compileLibraryFile } from '../src/sources.js';
import { createCoverageReadback } from '../../umgeni/src/gpu/readback.js';
import { paintCoverage, textBeziers, textSpansParams } from '../src/text/host.js';
import { coverageDiff, coveragePlan, requireDevice } from './gpu-check.js';

const library = compileLibraryFile('demos/nl/text.nl-lib');
const nile = library.api;

const PARA = PARAGRAPH;

// CPU back half: decompose → sort → sort → combine → paint.
const cpuCoverage = (beziers: number[][], width: number, height: number): Float64Array =>
  paintCoverage(nile.Rasterize().run(beziers), width, height);

const device = await requireDevice();

interface Case {
  name: string;
  text: string;
  size: number;
  width: number;
  height: number;
}
const CASES: Case[] = [
  { name: '1 paragraph', text: PARA, size: 18, width: 880, height: 360 },
  { name: '16 paragraphs', text: PARA.repeat(16), size: 18, width: 1760, height: 1600 },
  { name: '64 paragraphs', text: PARA.repeat(64), size: 14, width: 2560, height: 2560 },
];

for (const c of CASES) {
  const params = textSpansParams({ size: c.size, width: c.width, height: c.height, margin: 8 });
  // The front half once, as f32: both back halves see the same geometry.
  const flat = new Float32Array(textBeziers(nile, c.text, params).flat());
  const n = flat.length / 6;
  const beziers = Array.from({ length: n }, (_, i) => Array.from(flat.subarray(i * 6, i * 6 + 6)));

  const gpu = createCoverageReadback(device, coveragePlan(library.ir, 'RasterizePixels', c.width, c.height));
  const cpuCov = cpuCoverage(beziers, c.width, c.height);
  const gpuCov = await gpu.render(flat, n);
  if (gpu.overflowed()) throw new Error('worklist overflow');
  const d = coverageDiff(cpuCov, gpuCov);

  for (let i = 0; i < 3; i++) {
    cpuCoverage(beziers, c.width, c.height);
    await gpu.render(flat, n);
  }
  const cpuTimes: number[] = [];
  const gpuTimes: number[] = [];
  for (let i = 0; i < 9; i++) {
    let t0 = performance.now();
    cpuCoverage(beziers, c.width, c.height);
    cpuTimes.push(performance.now() - t0);
    t0 = performance.now();
    await gpu.render(flat, n);
    gpuTimes.push(performance.now() - t0);
  }
  gpu.dispose();

  console.log(
    `${c.name.padEnd(14)} | ${String(n).padStart(6)} beziers, ${c.width}x${c.height} | ` +
    `px diff max ${d.max.toFixed(4)} mean ${d.mean.toExponential(1)} (${d.covered} px covered) | ` +
    `CPU ${median(cpuTimes).toFixed(2)} ms | GPU ${median(gpuTimes).toFixed(2)} ms (1 fence)`,
  );
}
