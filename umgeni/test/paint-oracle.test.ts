// Differential test against the original system for gezira's higher-order
// paint library: templates with process-typed parameters (Texture,
// Compositor, ColorSpans) instantiated by closure inlining, and DupZip.
// Scenes: fixtures/paint-scenes.nl, mirrored in tools/oracle/harness.c.
import { describe, expect, it } from 'vitest';
import { collect, paintOracle, paintSources } from './sources.js';
import { compileLibrary, makeStreamer } from '../src/compile.js';

const cases = paintOracle();
const sources = paintSources();

describe.each([
  ['fused + cse', {}],
  ['unfused, no cse', { fuse: false, cse: false }],
])('gezira paint library vs the original runtime (%s)', (_, opts) => {
  const library = compileLibrary(sources, opts);
  it('compiles the whole library: nothing unsupported, the higher-order processes as templates', () => {
    expect(library.unsupported).toEqual([]);
    expect(library.templates).toContain('ApplyTexture');
    expect(library.templates).toContain('GaussianBlur1x21');
  });
  for (const c of cases) {
    it(c.process, () => {
      const out = collect(makeStreamer(library, c.process), c.input);
      expect(out.length).toBe(c.output.length);
      out.forEach((t, i) => t.forEach((x, j) => expect(Math.abs(x - c.output[i][j])).toBeLessThan(1e-9)));
    });
  }
});
