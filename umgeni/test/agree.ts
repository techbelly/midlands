// The interpreter (the semantics on numbers) against the compiler (the same
// semantics, staged), every plain kernel of a program: random parameters and
// streams, outputs equal bit for bit. Call inside a describe().
import { expect, it } from 'vitest';
import { compileLibrary } from '../src/compile.js';
import { parseProgram } from '../src/parser.js';
import { kernelContexts } from '../src/elaborate.js';
import { interpretKernel } from '../src/semantics/concrete.js';
import { run } from '../src/cpu/runtime.js';
import { shapeWidth } from '../src/values.js';

let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
// Values that exercise branches: small integers, halves, fractions, negatives.
const value = () => [0, 1, -1, 0.5, 2, 3.25, -2.75][Math.floor(rnd() * 7)] + (rnd() < 0.5 ? 0 : Math.round(rnd() * 160) / 16);

export function agree(sources: string[]) {
  const compiled = compileLibrary(sources);
  const { program, kernels } = kernelContexts(parseProgram(sources).modules);
  it('covers the kernels', () => expect(kernels.size).toBeGreaterThan(3));
  for (const [name, ctx] of kernels) {
    it(name, () => {
      const factory = compiled.registry.get(name);
      if (!factory) return; // not compiled (e.g. part of a family)
      const pw = ctx.params.reduce((n, g) => n + g.names.length * shapeWidth(g.shape), 0);
      const iw = shapeWidth(ctx.sig.input);
      for (let trial = 0; trial < 12; trial++) {
        const params = Array.from({ length: pw }, value);
        const input = Array.from({ length: 1 + (trial % 6) }, () => Array.from({ length: iw }, value));
        const want = run(factory(params), input.map((t) => [...t]));
        const got = run(interpretKernel(program, ctx.kernel, ctx.params, ctx.sig, params), input.map((t) => [...t]));
        expect(got.length, `${name} #outputs`).toBe(want.length);
        got.forEach((t, i) => t.forEach((x, j) => expect(Object.is(x, want[i][j]), `${name} out ${i}.${j}: ${x} vs ${want[i][j]}`).toBe(true)));
      }
    });
  }
}
