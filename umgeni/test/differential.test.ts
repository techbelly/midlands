// Differential test against chari, the earlier, tiger-validated closure
// compiler for Nile: its outputs on fixtures/chari-kernels.nl, recorded in
// fixtures/chari-oracle.json (tools/oracle/gen-chari-fixtures.ts). Both
// compilers do the same arithmetic in the same order, so equality is
// bitwise, not approximate — fused or not.
import { describe, expect, it } from 'vitest';
import { compileLibrary } from '../src/compile.js';
import { run } from '../src/cpu/runtime.js';
import { fixture } from './sources.js';

const kernels = fixture('chari-kernels.nl');
const oracle: { cases: { what: string; process: string; params: number[]; input: number[][]; output: number[][] }[] } =
  JSON.parse(fixture('chari-oracle.json'), (_, v) => (v === '-0' ? -0 : v));

// chari builds `~` (midpoint) in; for umgeni it is an ordinary operator
// definition, supplied as a prelude module.
const MIDPOINT_PRELUDE = ['(a : Real) ~ (b : Real) : Real', '    (a + b) / 2', ''].join('\n');

describe.each([
  ['unfused', { fuse: false }],
  ['fused', { fuse: true }],
])('differential vs chari (%s)', (_, opts) => {
  const library = compileLibrary([MIDPOINT_PRELUDE, kernels], opts);
  if (opts.fuse) it('fuses', () => expect(library.source).toContain('// segment:'));
  for (const c of oracle.cases) {
    it(`${c.process}: ${c.what}`, () => {
      const factory = library.registry.get(c.process);
      expect(factory, `umgeni has '${c.process}'`).toBeDefined();
      expect(run(factory!(c.params), c.input.map((t) => [...t]))).toEqual(c.output);
    });
  }
});
