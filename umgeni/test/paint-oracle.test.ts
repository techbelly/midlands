// Differential test against the original system for gezira's higher-order
// paint library: templates with process-typed parameters (Texture,
// Compositor, ColorSpans) instantiated by closure inlining, and DupZip.
// Scenes: fixtures/paint-scenes.nl, mirrored in tools/oracle/harness.c.
import { describe, expect, it } from 'vitest';
import { fixture, gezira } from './sources.js';
import { compileProgram, makeStreamer } from '../src/compile.js';

const oracle: { cases: { process: string; input: number[][]; output: number[][] }[] } =
  JSON.parse(fixture('paint-oracle.json'));
const sources = [...['types.nl', 'texture.nl', 'compositor.nl', 'gradient.nl', 'filter.nl'].map(gezira), fixture('paint-scenes.nl')];

describe.each([
  ['fused + cse', {}],
  ['unfused, no cse', { fuse: false, cse: false }],
])('gezira paint library vs the original runtime (%s)', (_, opts) => {
  const program = compileProgram(sources, opts);
  it('compiles the whole library: nothing unsupported, the higher-order processes as templates', () => {
    expect(program.unsupported).toEqual([]);
    expect(program.templates).toContain('ApplyTexture');
    expect(program.templates).toContain('GaussianBlur1x21');
  });
  for (const c of oracle.cases) {
    it(c.process, () => {
      const s = makeStreamer(program, c.process);
      const out = [...c.input.flatMap((t) => s.push(t)), ...s.end()];
      expect(out.length).toBe(c.output.length);
      out.forEach((t, i) => t.forEach((x, j) => expect(Math.abs(x - c.output[i][j])).toBeLessThan(1e-9)));
    });
  }
});
