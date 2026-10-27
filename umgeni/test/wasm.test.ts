// The WebAssembly backend (src/cpu/wasm.ts) against the JS backend: wasm f64 is
// IEEE-identical to JS numbers, so every fused run compiled to wasm must
// produce BIT-IDENTICAL output. Inputs are the oracle suites' cases;
// demos/test/wasm.test.ts does the same for the text and tiger demos.
import { describe, expect, it } from 'vitest';
import { compileLibrary, makeStreamer } from '../src/compile.js';
import { collect, paintOracle, paintSources, strokeOracle, strokeSources } from './sources.js';

function both(sources: string[], process: string, cases: { params?: number[]; input: number[][] }[]) {
  const js = compileLibrary(sources);
  const wasm = compileLibrary(sources, { target: 'wasm' });
  expect(wasm.source).toContain('rt.wasmPipeline(');
  for (const c of cases) {
    const run = (p: typeof js) => collect(makeStreamer(p, process, c.params ?? []), c.input);
    const a = run(js);
    expect(a.length).toBeGreaterThan(0);
    expect(run(wasm)).toEqual(a); // toEqual on numbers: exact (Object.is per element)
  }
}

describe('wasm backend: bit-identical to JS', () => {
  it('gezira strokes (mid-stream ⇒, generators, DupCat, Reverse)', () => {
    const cases = strokeOracle();
    for (const p of ['StrokeBezierPath', 'StrokeOneSide']) both(strokeSources(), p, cases.filter((c) => c.process === p));
  });

  it('gezira paint library (templates, DupZip, filters)', () => {
    for (const c of paintOracle()) both(paintSources(), c.process, [c]);
  });
});
