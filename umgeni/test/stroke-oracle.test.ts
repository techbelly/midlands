// Differential test against the ORIGINAL system: gezira's stroke processes as
// compiled by Amelang's own Nile compiler and run on the original C runtime
// (tools/oracle/, float widened to double), recorded in
// fixtures/stroke-oracle.json. These processes use mid-stream ⇒, generator
// recursion, DupCat and Reverse — the higher-order constructs — and Umgeni
// compiles the corpus source unmodified.
import { describe, expect, it } from 'vitest';
import { gezira, fixture } from './sources.js';
import { compileProgram, makeStreamer } from '../src/compile.js';

const oracle: { cases: { process: string; params: number[]; input: number[][]; output: number[][] }[] } =
  JSON.parse(fixture('stroke-oracle.json'));
const sources = ['types.nl', 'bezier.nl', 'stroke.nl'].map(gezira);

describe.each([
  ['fused + cse', {}],
  ['unfused, no cse', { fuse: false, cse: false }],
])('gezira stroke.nl vs the original runtime (%s)', (_, opts) => {
  const program = compileProgram(sources, opts);
  for (const process of [...new Set(oracle.cases.map((c) => c.process))]) {
    it(process, () => {
      for (const c of oracle.cases.filter((x) => x.process === process)) {
        const s = makeStreamer(program, c.process, c.params);
        const out = [...c.input.flatMap((t) => s.push(t)), ...s.end()];
        expect(out.length).toBe(c.output.length);
        out.forEach((t, i) => t.forEach((x, j) => expect(Math.abs(x - c.output[i][j])).toBeLessThan(1e-6)));
      }
    });
  }
});
