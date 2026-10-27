// Work kept between runs (rt.memoPipeline): a fused pipeline run again over
// the same array reuses what its barriers left, as far as the parameters
// read before each barrier are unchanged. The text pipeline is the case:
// Reverse → WordWidths → Reverse → LayoutGlyphs (w, lh) → TransformBeziers (M)
// → ClipBeziers (min, max) → Rasterize. A new matrix starts after the second
// Reverse; a new line width starts from the top; nothing new costs nothing.
import { describe, expect, it } from 'vitest';
import { gezira, roda } from './sources.js';
import { compileLibrary, makeStreamer, type CompileOptions } from '../src/compile.js';
import { collect } from './sources.js';

const sources = () => [...['types.nl', 'bezier.nl', 'rasterize.nl'].map(gezira), roda('text.nl')];

// A paragraph of made-up glyphs: (Z : Bezier, adv, first, kind, rest), ten
// numbers, from a fixed generator so every test sees the same tokens.
function glyphs(n: number): number[][] {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 7 === 6 ? 1 : i % 40 === 39 ? 2 : 0;
    const first = i % 3 === 0 ? 1 : 0;
    const z = Array.from({ length: 6 }, () => rnd());
    out.push([...z, 0.4 + rnd() * 0.3, first, kind, 0]);
  }
  return out;
}

const params = { w: 20, lh: 1.2, M: [12, 0, 0, 12, 5, 5], min: [0, 0], max: [400, 300] };
const compile = (opts: CompileOptions = {}) => compileLibrary(sources(), { countOps: true, ...opts });

describe('work kept between runs', () => {
  it('the text pipeline compiles whole', () => {
    expect(compile().unsupported.map((u) => u.name)).not.toContain('TextSpans');
  });

  it('a run over the same array with the same parameters costs nothing', () => {
    const lib = compile();
    const tokens = glyphs(300);
    const first = lib.api.TextSpans(params).run(tokens);
    const before = lib.ops!();
    const again = lib.api.TextSpans(params).run(tokens);
    expect(lib.ops!() - before).toBe(0);
    expect(again).toBe(first); // the kept array itself: a chain of runs keeps its identity
  });

  it('identity flows from one process to the next: a chain of runs costs nothing', () => {
    const lib = compile();
    const tokens = glyphs(300);
    const place = { w: 20, lh: 1.2 };
    const spans = (M: number[]) => lib.api.Rasterize().run(lib.api.TextBeziers({ ...place, M, min: [0, 0], max: [400, 300] }).run(tokens));
    const first = spans([12, 0, 0, 12, 5, 5]);
    const t0 = lib.ops!();
    expect(spans([12, 0, 0, 12, 5, 5])).toBe(first);
    expect(lib.ops!() - t0).toBe(0);
    const moved = spans([12, 0, 0, 12, 40, 7]);
    expect(moved).not.toBe(first);
    expect(moved).toEqual(lib.api.TextSpans({ ...place, M: [12, 0, 0, 12, 40, 7], min: [0, 0], max: [400, 300] }).run(tokens.map((t) => t.slice())));
  });

  it('a new matrix reruns only the stages after the second Reverse', () => {
    const lib = compile();
    const tokens = glyphs(300);
    const t0 = lib.ops!();
    lib.api.TextSpans(params).run(tokens);
    const full = lib.ops!() - t0;
    const moved = { ...params, M: [12, 0, 0, 12, 40, 7] };
    const t1 = lib.ops!();
    const got = lib.api.TextSpans(moved).run(tokens);
    const partial = lib.ops!() - t1;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(full);
    // The same as a run that remembers nothing: a fresh array.
    const fresh = lib.api.TextSpans(moved).run(tokens.map((t) => t.slice()));
    expect(got).toEqual(fresh);
  });

  it('a new line width starts at the layout too, saving exactly WordWidths', () => {
    // Nothing before LayoutGlyphs reads a parameter, so the two Reverses
    // and WordWidths are kept; what a remembered run saves is WordWidths'
    // ops (a Reverse has none).
    const lib = compile();
    const tokens = glyphs(300);
    lib.api.TextSpans(params).run(tokens);
    const narrow = { ...params, w: 15 };
    const t0 = lib.ops!();
    const fresh = lib.api.TextSpans(narrow).run(tokens.map((t) => t.slice()));
    const full = lib.ops!() - t0;
    const t1 = lib.ops!();
    const kept = lib.api.TextSpans(narrow).run(tokens);
    const partial = lib.ops!() - t1;
    expect(kept).toEqual(fresh);
    const t2 = lib.ops!();
    lib.api.WordWidths().run(tokens.map((t) => t.slice()));
    expect(full - partial).toBe(lib.ops!() - t2);
  });

  it('a parameter the first stage reads reruns everything', () => {
    // FillPath (M, min, max): TransformCubics (M) → FlattenCubics → ClipBeziers → Rasterize.
    const lib = compileLibrary([...sources(), roda('vector.nl')], { countOps: true });
    const cubics = glyphs(100).map((t) => [...t.slice(0, 6), t[0] + 1, t[1] + 1]);
    const fill = { M: [40, 0, 0, 40, 0, 0], min: [0, 0], max: [100, 100] };
    const t0 = lib.ops!();
    lib.api.FillPath(fill).run(cubics);
    const full = lib.ops!() - t0;
    const t1 = lib.ops!();
    lib.api.FillPath({ ...fill, M: [40, 0, 0, 40, 3, 3] }).run(cubics);
    expect(lib.ops!() - t1).toBe(full);
    const t2 = lib.ops!();
    lib.api.FillPath({ ...fill, M: [40, 0, 0, 40, 3, 3] }).run(cubics);
    expect(lib.ops!() - t2).toBe(0);
  });

  it('token by token, nothing is kept and the answer is the same', () => {
    const lib = compile();
    const tokens = glyphs(120);
    const whole = lib.api.TextSpans(params).run(tokens);
    const streamed = collect(makeStreamer(lib, 'TextSpans', params), tokens);
    expect(streamed).toEqual(whole);
    const t0 = lib.ops!();
    collect(makeStreamer(lib, 'TextSpans', params), tokens);
    expect(lib.ops!() - t0).toBeGreaterThan(0);
  });

  it('as WebAssembly, the same runs give the same spans', () => {
    const js = compile();
    const wasm = compileLibrary(sources(), { target: 'wasm' });
    const tokens = glyphs(300);
    const moved = { ...params, M: [12, 0, 0, 12, 40, 7] };
    for (const p of [params, params, moved, params]) {
      expect(wasm.api.TextSpans(p).run(tokens)).toEqual(js.api.TextSpans(p).run(tokens));
    }
  });
});
