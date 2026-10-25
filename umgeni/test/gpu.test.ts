// Node-side tests for the GPU backend's pure parts (classification, WGSL
// generation, state folding). Actual GPU execution runs under Deno —
// `npm run bench:gpu` — which also checks GPU-vs-CPU output tolerance.

import { describe, expect, it } from 'vitest';
import { gezira, nl } from './sources.js';
import { compileLibrary } from '../src/compile.js';
import { isMapKernel } from '../src/gpu/classify.js';
import { genMapShader } from '../src/gpu/wgsl.js';
import { evalStateInit } from '../src/gpu/eval.js';
import { lowerPipeline, LowerError } from '../src/gpu/lower.js';
import { appendSink, coverageSink } from '../src/gpu/execute.js';
import type { KernelIR } from '../src/ir.js';


function kernelsOf(...files: string[]): KernelIR[] {
  const library = compileLibrary(files.map(gezira));
  return library.ir.processes.filter((p): p is KernelIR => p.k === 'kernel');
}

describe('GPU kernel classification', () => {
  it('classifies the rasterizer corpus correctly', () => {
    const kernels = kernelsOf('types.nl', 'bezier.nl', 'rasterize.nl');
    const maps = kernels.filter(isMapKernel).map((k) => k.name);
    // Feedback (DecomposeBeziers, ClipBeziers, RectangleSpans), carried state
    // (CombineEdgeSamples), and epilogues (CalculateBounds) are all excluded.
    expect(maps).toEqual(['TransformBeziers']);
  });

  it('classifies all compositors as map kernels', () => {
    const kernels = kernelsOf('types.nl', 'compositor.nl');
    const maps = kernels.filter(isMapKernel);
    expect(maps.length).toBe(kernels.length);
    expect(maps.length).toBeGreaterThan(20);
  });
});

describe('WGSL generation', () => {
  it('generates the TransformBeziers shader (golden)', () => {
    const kernel = kernelsOf('types.nl', 'bezier.nl').find((k) => k.name === 'TransformBeziers')!;
    expect(genMapShader(kernel)).toMatchSnapshot();
  });

  it('formats numbers as valid WGSL f32 literals', () => {
    const src = [
      'K : Real >> Real',
      '    ∀ a',
      '        >> {a × 2 if a < 0.5, -1}',
    ].join('\n');
    const kernel = compileLibrary([src]).ir.processes[0] as KernelIR;
    const shader = genMapShader(kernel);
    expect(shader).toContain('2.0');     // integer constants get a decimal
    expect(shader).toContain('(-1.0)');
    expect(shader).toContain('< 0.5');   // conditions stay native bool
    expect(shader).toContain('select('); // guard select, WGSL argument order
  });

  it('rejects non-map kernels', () => {
    const decompose = kernelsOf('types.nl', 'rasterize.nl').find((k) => k.name === 'DecomposeBeziers')!;
    expect(isMapKernel(decompose)).toBe(false);
  });
});

describe('pipeline lowering (gpu/lower.ts)', () => {
  const sources = ['types.nl', 'bezier.nl', 'rasterize.nl', 'texture.nl'].map(gezira);
  const nlSrc = nl('rasterize-parallel.nl');
  const fusedOf = (library: ReturnType<typeof compileLibrary>, name: string) => {
    const f = library.ir.processes.find((p) => p.k === 'fused' && p.name === name);
    if (!f || f.k !== 'fused') throw new Error(`${name} not fused`);
    return f;
  };
  const frame = (sink = coverageSink) => ({ extent: [360, 880], sink });

  it('lowers RasterizeParallel to a plan of two passes from IR alone (golden)', () => {
    const plan = lowerPipeline(fusedOf(compileLibrary([...sources, nlSrc]), 'RasterizeParallel'), frame());
    expect(plan.passes.map((p) => [p.name, p.over])).toEqual([
      ['DecomposeBeziers', 'tokens'],
      ['WindScan → SpansOf', 'segments'],
    ]);
    expect(plan.grids).toEqual(['G0', 'G1']);
    expect(plan.cells).toBe(360 * 880);
    const [a, b] = plan.passes;
    // Feedback lowered to the per-thread worklist, emit to grid atomics.
    expect(a.wgsl).toContain('atomicAdd(&G0[');
    expect(a.wgsl).toContain('sp0 += 1u;');
    // WGSL reserves the `__` prefix; CSE temporaries must not collide.
    expect(a.wgsl).not.toMatch(/\b__/);
    expect(b.wgsl).not.toMatch(/\b__/);
    expect(b.bindings.map((x) => x.name)).toEqual(['META', 'G0', 'G1', 'COV']);
    expect(a.wgsl).toMatchSnapshot();
    expect(b.wgsl).toMatchSnapshot();
  });

  it('lowers a feedback kernel after the window (RasterizeParallel → ExpandSpans) with a per-point sink', () => {
    const plan = lowerPipeline(fusedOf(compileLibrary([...sources, nlSrc]), 'RasterizePixels'), frame());
    expect(plan.passes.map((p) => p.name)).toEqual(['DecomposeBeziers', 'WindScan → SpansOf → ExpandSpans']);
    const b = plan.passes[1];
    // ExpandSpans feeds once per token, at the end: a loop, not a worklist.
    expect(b.wgsl).toContain('again = true;');
    expect(b.wgsl).not.toContain('var<private> F2');
    expect(b.bindings.map((x) => x.role)).toEqual(['meta', 'grid', 'grid', 'sink']);
  });

  it('lowers a parameterized map prefix (TransformBeziers → RasterizeParallel)', () => {
    const src = `${nlSrc}\nRasterizeMapped (M : Matrix) : Bezier >> CoverageSpan\n    ⇒ TransformBeziers (M) → RasterizeParallel\n`;
    const plan = lowerPipeline(fusedOf(compileLibrary([...sources, src]), 'RasterizeMapped'), frame());
    expect(plan.paramWidth).toBe(6);
    const a = plan.passes[0];
    expect(a.name).toBe('TransformBeziers → DecomposeBeziers');
    expect(a.bindings.map((x) => x.name)).toEqual(['META', 'INBUF', 'P', 'OVERFLOW', 'G0', 'G1']);
    expect(a.wgsl).toContain('P[0u]');
    expect(a.wgsl).toContain('st1('); // TransformBeziers emits into DecomposeBeziers
  });

  it('appends tokens for a pipeline of maps and feedback (ExpandSpans alone)', () => {
    const library = compileLibrary([...sources, 'Expand : CoverageSpan >> CoveragePoint\n    ⇒ ExpandSpans\n']);
    const plan = lowerPipeline(fusedOf(library, 'Expand'), { extent: [1], sink: appendSink(4) });
    expect(plan.passes).toHaveLength(1);
    expect(plan.passes[0].bindings.map((x) => x.name)).toEqual(['META', 'INBUF', 'OUT', 'COUNT']);
    expect(plan.grids).toEqual([]);
  });

  it('refuses what no declaration licenses, naming the declaration', () => {
    const refuse = (nile: string, name: string, why: RegExp) => {
      const library = compileLibrary([...sources, nile]);
      expect(() => lowerPipeline(fusedOf(library, name), frame())).toThrow(LowerError);
      expect(() => lowerPipeline(fusedOf(library, name), frame())).toThrow(why);
    };
    refuse(nlSrc.replace('GroupBy (@y, @x)', 'GroupBy stable (@y, @x)'), 'RasterizeParallel', /stable cannot lower to atomic grids/);
    // The sequential rasterizer: SortBy has no parallel reading.
    refuse('', 'Rasterize', /SortBy needs the whole stream in order/);
    // Carried state on an ungrouped stream.
    refuse('Combine : EdgeSample >> CoverageSpan\n    ⇒ DecomposeBeziers → CombineEdgeSamples\n', 'Combine', /a flush body runs once per stream; it needs a segment/);
    // A scan by the wrong key.
    refuse(nlSrc.replace('+[ h ] by @y', '+[ h ] by @x'), 'RasterizeParallel', /scans by a field that is not the grid's major key/);
    // A window that does not declare its segment.
    refuse(nlSrc.replace('∀ p ∷ q by @y', '∀ p ∷ q'), 'RasterizeParallel', /must declare its segment/);
  });
});

describe('state folding', () => {
  it('evaluates prologue state from params (LinearGradient)', () => {
    const kernel = kernelsOf('types.nl', 'gradient.nl').find((k) => k.name === 'LinearGradient')!;
    expect(isMapKernel(kernel)).toBe(true);
    // S=(0,0), E=(2,0): v=(2,0), d=(0.5,0), s00=0
    const state = evalStateInit(kernel.stateInit, [0, 0, 2, 0]);
    expect(state).toEqual([2, 0, 0.5, 0, 0]);
  });
});
