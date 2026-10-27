// Differential test against the ORIGINAL system: gezira's stroke processes as
// compiled by Amelang's own Nile compiler and run on the original C runtime
// (tools/oracle/, float widened to double), recorded in
// fixtures/stroke-oracle.json. These processes use mid-stream ⇒, generator
// recursion, DupCat and Reverse — the higher-order constructs — and Umgeni
// compiles the corpus source unmodified.
import { describe, expect, it } from 'vitest';
import { collect, strokeOracle, strokeSources } from './sources.js';
import { compileLibrary, makeStreamer } from '../src/compile.js';

const cases = strokeOracle();
const sources = strokeSources();

describe.each([
  ['fused + cse', {}],
  ['unfused, no cse', { fuse: false, cse: false }],
])('gezira stroke.nl vs the original runtime (%s)', (_, opts) => {
  const library = compileLibrary(sources, opts);
  for (const process of [...new Set(cases.map((c) => c.process))]) {
    it(process, () => {
      for (const c of cases.filter((x) => x.process === process)) {
        const out = collect(makeStreamer(library, c.process, c.params), c.input);
        expect(out.length).toBe(c.output.length);
        out.forEach((t, i) => t.forEach((x, j) => expect(Math.abs(x - c.output[i][j])).toBeLessThan(1e-6)));
      }
    });
  }
});
