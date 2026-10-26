// The WebAssembly backend (src/cpu/wasm.ts) against the JS backend: wasm f64 is
// IEEE-identical to JS numbers, so every fused run compiled to wasm must
// produce BIT-IDENTICAL output. Inputs are the oracle suites' cases;
// demos/test/wasm.test.ts does the same for the text and tiger demos.
import { describe, expect, it } from 'vitest';
import { compileLibrary, makeStreamer } from '../src/compile.js';
import { fixture, gezira } from './sources.js';

function both(sources: string[], process: string, cases: { params?: number[]; input: number[][] }[]) {
  const js = compileLibrary(sources);
  const wasm = compileLibrary(sources, { target: 'wasm' });
  expect(wasm.source).toContain('rt.wasmPipeline(');
  for (const c of cases) {
    const run = (p: typeof js) => {
      const s = makeStreamer(p, process, c.params ?? []);
      return [...c.input.flatMap((t) => s.push(t)), ...s.end()];
    };
    const a = run(js);
    expect(a.length).toBeGreaterThan(0);
    expect(run(wasm)).toEqual(a); // toEqual on numbers: exact (Object.is per element)
  }
}

describe('wasm backend: bit-identical to JS', () => {
  it('gezira strokes (mid-stream ⇒, generators, DupCat, Reverse)', () => {
    const oracle = JSON.parse(fixture('stroke-oracle.json'));
    const sources = ['types.nl', 'bezier.nl', 'stroke.nl'].map(gezira);
    for (const p of ['StrokeBezierPath', 'StrokeOneSide']) {
      both(sources, p, oracle.cases.filter((c: { process: string }) => c.process === p));
    }
  });

  it('gezira paint library (templates, DupZip, filters)', () => {
    const oracle = JSON.parse(fixture('paint-oracle.json'));
    const sources = [...['types.nl', 'texture.nl', 'compositor.nl', 'gradient.nl', 'filter.nl'].map(gezira), fixture('paint-scenes.nl')];
    for (const c of oracle.cases) both(sources, c.process, [c]);
  });
});
