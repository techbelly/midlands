// Node-side tests for the GPU backend's pure parts (classification, WGSL
// generation, state folding). Actual GPU execution runs under Deno —
// `npm run bench:gpu` — which also checks GPU-vs-CPU output tolerance.

import { describe, expect, it } from 'vitest';
import { gezira, nl } from './sources.js';
import { compileProgram } from '../src/compile.js';
import { isMapKernel } from '../src/gpu/classify.js';
import { genMapShader } from '../src/gpu/wgsl.js';
import { evalStateInit } from '../src/gpu/eval.js';
import type { KernelIR } from '../src/ir.js';


function kernelsOf(...files: string[]): KernelIR[] {
  const program = compileProgram(files.map(gezira));
  return program.ir.processes.filter((p): p is KernelIR => p.k === 'kernel');
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
    const kernel = compileProgram([src]).ir.processes[0] as KernelIR;
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

describe('resident rasterizer shaders', () => {
  it('generates the decompose worklist shader from Nile IR (golden)', async () => {
    const { genDecomposeShader } = await import('../src/gpu/lower.js');
    const kernel = kernelsOf('types.nl', 'rasterize.nl').find((k) => k.name === 'DecomposeBeziers')!;
    const shader = genDecomposeShader(kernel, { width: 880, height: 360 });
    expect(shader).toMatchSnapshot();
    // WGSL reserves the `__` prefix; CSE temporaries must not collide.
    expect(shader).not.toMatch(/\b__/);
    // Feedback lowered to the per-thread worklist, emit to grid atomics.
    expect(shader).toContain('atomicAdd(&GA[');
    expect(shader).toContain('sp += 1u;');
  });

  it('rejects kernels without the decompose shape', async () => {
    const { genDecomposeShader } = await import('../src/gpu/lower.js');
    const combine = kernelsOf('types.nl', 'rasterize.nl').find((k) => k.name === 'CombineEdgeSamples')!;
    expect(() => genDecomposeShader(combine, { width: 8, height: 8 })).toThrow(/decompose shape/);
  });
});

describe('pipeline lowering (gpu/lower.ts)', () => {
  const rasterizeParallelSources = ['types.nl', 'bezier.nl', 'rasterize.nl'].map(gezira);
  const nlSrc = nl('rasterize-parallel.nl');

  it('lowers RasterizeParallel to both shaders from IR alone (golden)', async () => {
    const { lowerFusedPipeline } = await import('../src/gpu/lower.js');
    const program = compileProgram([...rasterizeParallelSources, nlSrc]);
    const fused = program.ir.processes.find((p) => p.k === 'fused' && p.name === 'RasterizeParallel');
    expect(fused?.k).toBe('fused');
    const shaders = lowerFusedPipeline(fused as never, { width: 880, height: 360 });
    // Kernel logic in both passes is generated; scaffolding is the backend.
    expect(shaders.decompose).toContain('atomicAdd(&GA[');
    expect(shaders.resolve).toContain("generated from 'WindScan'");
    expect(shaders.resolve).toMatchSnapshot();
  });

  it('refuses shapes the lowering cannot honour, with reasons', async () => {
    const { recognize, LowerError } = await import('../src/gpu/lower.js');
    const stable = compileProgram([
      ...rasterizeParallelSources,
      nlSrc.replace('GroupBy (@y, @x)', 'GroupBy stable (@y, @x)'),
    ]);
    const fused = stable.ir.processes.find((p) => p.k === 'fused' && p.name === 'RasterizeParallel');
    expect(() => recognize(fused as never)).toThrow(LowerError);
    expect(() => recognize(fused as never)).toThrow(/stable cannot lower to atomic grids/);
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
