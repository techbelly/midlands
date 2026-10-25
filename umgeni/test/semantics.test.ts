// Nile kernel semantics, written once (src/semantics/nile.mooi). Run on
// numbers it is an interpreter; staged, it is the compiler's front end. Here
// every plain kernel in every program is run both ways — the interpreter vs
// the ordinary compiler's code — on random parameters and streams, and must
// agree bit for bit (Object.is on every output value).
import { describe, expect, it } from 'vitest';
import { compileProgram } from '../src/compile.js';
import { parseProgram } from '../src/parser.js';
import { kernelContexts } from '../src/elaborate.js';
import { interpretKernel } from '../src/semantics/concrete.js';
import { agree } from './agree.js';
import { fixture, gezira, nl } from './sources.js';

const library = ['types', 'bezier', 'stroke', 'rasterize', 'texture', 'compositor', 'gradient', 'filter'].map((n) => gezira(`${n}.nl`));
const PROGRAMS: [string, string[]][] = [
  ['gezira + paint scenes', [...library, fixture('paint-scenes.nl')]],
  ['RasterizeParallel', [gezira('types.nl'), gezira('bezier.nl'), gezira('rasterize.nl'), gezira('texture.nl'), nl('rasterize-parallel.nl')]],
  ['chari kernels', [fixture('chari-kernels.nl')]],
];

describe.each(PROGRAMS)('interpreter ≡ compiler, kernel by kernel: %s', (_, sources) => agree(sources));

// Mid-stream ⇒, interpreted literally (the process becomes the pipeline, as
// in the 2012 C runtime) vs the compiler's defunctionalization
// (substitute.ts) vs the 2012 runtime itself (fixtures/stroke-oracle.json).
import { dupCat, pipeline, reverse, run } from '../src/cpu/runtime.js';

describe('mid-stream ⇒: interpreter ≡ compiler ≡ the 2012 runtime', () => {
  const sources = ['types', 'bezier', 'stroke'].map((n) => gezira(`${n}.nl`));
  const compiled = compileProgram(sources);
  const { program, kernels } = kernelContexts(parseProgram(sources).modules, true);
  const interp = (name: string, params: number[] = []) => {
    const c = kernels.get(name)!;
    return interpretKernel(program, c.kernel, c.params, c.sig, params, (n) => kernels.get(n));
  };
  const build: Record<string, (p: number[]) => ReturnType<typeof interp>> = {
    OffsetBezier: (p) => interp('OffsetBezier', p),
    StrokeOneSide: (p) => interp('StrokeOneSide', p),
    StrokeBezierPath: (p) => pipeline([
      interp('SanitizeBezierPath'),
      dupCat(interp('StrokeOneSide', p), pipeline([reverse(), interp('ReverseBeziers'), interp('StrokeOneSide', p)])),
    ]),
  };
  const oracle: { cases: { process: string; params: number[]; input: number[][]; output: number[][] }[] } =
    JSON.parse(fixture('stroke-oracle.json'));
  for (const process of Object.keys(build)) {
    it(process, () => {
      for (const c of oracle.cases.filter((x) => x.process === process)) {
        const got = run(build[process](c.params), c.input.map((t) => [...t]));
        const want = run(compiled.registry.get(process)!(c.params), c.input.map((t) => [...t]));
        expect(got.length).toBe(c.output.length);
        got.forEach((t, i) => t.forEach((x, j) => {
          expect(Math.abs(x - c.output[i][j])).toBeLessThan(1e-6); // the 2012 runtime
          expect(Object.is(x, want[i][j])).toBe(true); // the compiler, bit for bit
        }));
      }
    });
  }
});
