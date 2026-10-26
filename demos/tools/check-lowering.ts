// The GPU lowering is a compiler, not a template: pipelines it has never
// seen lower from their declarations and agree with the CPU. Three shapes
// beyond RasterizeParallel, each against the same Nile run by the JS backend:
//
//   RasterizePixels   a feedback kernel (ExpandSpans) after the window, and a
//                     per-pixel sink in place of the span loop
//   RasterizeMapped   a parameterized map kernel (TransformBeziers (M)) fused
//                     ahead of the worklist pass
//   Expand            ExpandSpans alone, one pass, output appended to a buffer
//
// Run: npm run check:lowering  (deno, with WebGPU)

import { librarySourceTexts } from '../src/sources.js';
import { compileLibrary } from '../../umgeni/src/compile.js';
import { createCoverageReadback, readAppended } from '../../umgeni/src/gpu/readback.js';
import { lowerPipeline, type Sink } from '../../umgeni/src/gpu/lower.js';
import { appendSink } from '../../umgeni/src/gpu/execute.js';
import { fusedPipeline } from '../../umgeni/src/ir.js';
import { paintCoverage, textBeziers, textSpansParams } from '../src/text/host.js';
import { compareCoverage, coveragePlan, requireDevice } from './gpu-check.js';

// The reference for ExpandSpans: a span (x, y, c, l) painted by a loop, as
// the presenter's sink did before ExpandSpans ran on the GPU in Nile.
const spanSink: Sink = {
  bindings: [{ name: 'COV', role: 'sink', access: 'read_write', type: 'array<f32>' }],
  emit: (vals, ind) => [
    `${ind}{`,
    `${ind}  let sx = i32(floor(${vals[0]}));`,
    `${ind}  let sy = i32(floor(${vals[1]}));`,
    `${ind}  let sl = i32(round(${vals[3]}));`,
    `${ind}  for (var si = 0; si < sl; si += 1) {`,
    `${ind}    let px = sx + si;`,
    `${ind}    if (px >= 0 && px < i32(META.minor) && sy >= 0 && sy < i32(META.major)) {`,
    `${ind}      let ci = u32(sy) * META.minor + u32(px);`,
    `${ind}      COV[ci] = min(COV[ci] + ${vals[2]}, 1.0);`,
    `${ind}    }`,
    `${ind}  }`,
    `${ind}}`,
  ].join('\n'),
};

const library = compileLibrary([
  ...librarySourceTexts('demos/nl/text.nl-lib'),
  // Two pipelines the lowering has not been written against.
  'RasterizeMapped (M : Matrix) : Bezier >> CoverageSpan\n    ⇒ TransformBeziers (M) → RasterizeParallel\n',
  'Expand : CoverageSpan >> CoveragePoint\n    ⇒ ExpandSpans\n',
]);
if (library.unsupported.length > 0) throw new Error(JSON.stringify(library.unsupported));
const nile = library.api;
const spanPlan = (name: string) => lowerPipeline(fusedPipeline(library.ir, name), { extent: [H, W], sink: spanSink });

const W = 320;
const H = 48;
const params = textSpansParams({ size: 16, width: W, height: H, margin: 4 });
const beziers = textBeziers(nile, 'ANY PIPELINE', params);
const flat = new Float32Array(beziers.flat());
const n = beziers.length;
const device = await requireDevice();
const drew = { min: 100 };

// 1. RasterizePixels: pixels from the GPU vs the CPU's spans expanded, and
// vs the GPU's own spans painted by the hand-written loop (spanSink), which
// the Nile ExpandSpans must reproduce exactly.
{
  const pixels = createCoverageReadback(device, coveragePlan(library.ir, 'RasterizePixels', W, H));
  const spans = createCoverageReadback(device, spanPlan('RasterizeParallel'));
  const cov = await pixels.render(flat, n);
  if (pixels.overflowed()) throw new Error('RasterizePixels: worklist overflow');
  compareCoverage('RasterizePixels vs the span loop, both on the GPU', await spans.render(flat, n), cov, 0, drew);
  // f32 vs f64: a sample on a pixel boundary can land one cell over.
  compareCoverage('RasterizePixels vs the CPU', paintCoverage(nile.RasterizeParallel().run(beziers), W, H), cov, 0.2, drew);
  pixels.dispose();
  spans.dispose();
}

// 2. RasterizeMapped: the matrix is a pipeline parameter the GPU reads from P.
{
  const M = [0.5, 0, 0, 0.5, 40, 10];
  // RasterizeMapped emits spans, so its sink is the span loop.
  const plan = spanPlan('RasterizeMapped');
  if (!plan.passes[0].bindings.some((b) => b.role === 'params')) throw new Error('RasterizeMapped: no params binding');
  const gpu = createCoverageReadback(device, plan, M);
  const cov = await gpu.render(flat, n);
  compareCoverage('RasterizeMapped (TransformBeziers (M) fused ahead, M from P) vs the CPU', paintCoverage(nile.RasterizeMapped({ M }).run(beziers), W, H), cov, 0.2, drew);
  gpu.dispose();
}

// 3. Expand: one pass, tokens appended; the CPU's output as a multiset.
{
  const spans = nile.RasterizeParallel().run(beziers);
  const cpu = nile.Expand().run(spans);
  const plan = lowerPipeline(fusedPipeline(library.ir, 'Expand'), { extent: [1], sink: appendSink(4) });
  const gpu = await readAppended(device, plan, spans, 4, cpu.length + 1024);
  if (gpu.length !== cpu.length) throw new Error(`Expand: GPU emitted ${gpu.length} tokens, CPU ${cpu.length}`);
  // Order is unspecified (threads finish as they finish): compare as sorted lists.
  const key = (t: ArrayLike<number>) => `${t[0]},${t[1]},${Math.fround(t[2]).toFixed(5)}`;
  const a = cpu.map(key).sort();
  const b = gpu.map(key).sort();
  const differ = a.filter((k, i) => k !== b[i]).length;
  if (differ > 0) throw new Error(`Expand: ${differ} of ${gpu.length} tokens differ`);
  console.log(`Expand (ExpandSpans alone, appended): ok, ${gpu.length} tokens, same multiset as the CPU`);
}
console.log('lowering ok');
