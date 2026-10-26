// Phase B v1: the GPU-resident rasterizer vs the CPU reference, on real text.
//
// Both sides share the CPU front half (layout → transform → clip, compiled
// from Nile). The back half — decompose → sort → combine → paint on CPU;
// decompose → grid → resolve on GPU, both shaders generated from
// RasterizeParallel's IR — is what's compared: max pixel difference (tolerance:
// fixed-point atomics + f32) and wall time with a single fence per frame.
//
// Run: npm run bench:gpu:resident   (Deno; panics at exit — wgpu teardown bug)

import { read } from '../src/sources.js';
import { compileLibrary } from '../../umgeni/src/compile.js';
import { createRasterHost } from '../../umgeni/src/gpu/raster.js';
import { lowerPipeline } from '../../umgeni/src/gpu/lower.js';
import { coverageSink } from '../../umgeni/src/gpu/execute.js';
import { requestDevice } from '../../umgeni/src/gpu/device.js';
import * as rt from '../../umgeni/src/cpu/runtime.js';
import { paintCoverage, textSpansParams, textTokens, type TextSpansParams } from '../src/text/host.js';

const library = compileLibrary([
  read('gezira/types.nl'),
  read('gezira/bezier.nl'),
  read('gezira/rasterize.nl'),
  read('gezira/texture.nl'),
  read('roda/text.nl'),
  read('roda/rasterize-parallel.nl'),
]);

const PARA =
  'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG. PACK MY BOX WITH FIVE DOZEN JUGS. ' +
  'UMGENI RENDERS THIS PARAGRAPH THROUGH A PIPELINE COMPILED FROM NILE SOURCE, WRAPPING LINES AS IT GOES. ';

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// CPU front half: laid-out, transformed, clipped beziers (shared by both sides).
function frontHalf(text: string, params: TextSpansParams): Float32Array<ArrayBuffer> {
  const op = library.api.TextBeziers(params);
  const out: number[] = [];
  op.setEmit((t) => out.push(...t));
  for (const t of textTokens(library.api, text)) op.push(t);
  op.end();
  return new Float32Array(out);
}

// CPU back half: decompose → sort → sort → combine → paint.
function cpuCoverage(beziers: Float32Array, width: number, height: number): Float64Array {
  const op = library.registry.get('Rasterize')!();
  const spans: number[][] = [];
  op.setEmit((t) => spans.push(t));
  const token = new Array(6);
  for (let i = 0; i < beziers.length; i += 6) {
    for (let j = 0; j < 6; j++) token[j] = beziers[i + j];
    op.push(token as number[]);
  }
  op.end();
  return paintCoverage(spans, width, height);
}

const device = await requestDevice();
if (!device) {
  console.error('No WebGPU device.');
  Deno.exit(1);
}
const fused = library.ir.processes.find((p) => p.k === 'fused' && p.name === 'RasterizePixels');
if (!fused || fused.k !== 'fused') throw new Error('RasterizePixels not fused');

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
  const beziers = frontHalf(c.text, params);
  const n = beziers.length / 6;

  const gpu = createRasterHost(device, lowerPipeline(fused, { extent: [c.height, c.width], sink: coverageSink }));
  const cpuCov = cpuCoverage(beziers, c.width, c.height);
  const gpuCov = await gpu.render(beziers, n);
  if (gpu.overflowed()) throw new Error('worklist overflow');

  let maxDiff = 0;
  let sumDiff = 0;
  let covered = 0;
  for (let i = 0; i < cpuCov.length; i++) {
    const d = Math.abs(cpuCov[i] - gpuCov[i]);
    maxDiff = Math.max(maxDiff, d);
    sumDiff += d;
    if (cpuCov[i] > 0.5) covered++;
  }
  const meanDiff = sumDiff / cpuCov.length;

  for (let i = 0; i < 3; i++) {
    cpuCoverage(beziers, c.width, c.height);
    await gpu.render(beziers, n);
  }
  const cpuTimes: number[] = [];
  const gpuTimes: number[] = [];
  for (let i = 0; i < 9; i++) {
    let t0 = performance.now();
    cpuCoverage(beziers, c.width, c.height);
    cpuTimes.push(performance.now() - t0);
    t0 = performance.now();
    await gpu.render(beziers, n);
    gpuTimes.push(performance.now() - t0);
  }
  gpu.dispose();

  console.log(
    `${c.name.padEnd(14)} | ${String(n).padStart(6)} beziers, ${c.width}x${c.height} | ` +
    `px diff max ${maxDiff.toFixed(4)} mean ${meanDiff.toExponential(1)} (${covered} px covered) | ` +
    `CPU ${median(cpuTimes).toFixed(2)} ms | GPU ${median(gpuTimes).toFixed(2)} ms (1 fence)`,
  );
}
