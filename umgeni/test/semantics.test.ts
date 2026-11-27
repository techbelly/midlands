// Nile kernel semantics, written once (src/semantics/nile.mooi). Run on
// numbers it is an interpreter; staged, it is the compiler's front end. Here
// every plain kernel in every program is run both ways — the interpreter vs
// the ordinary compiler's code — on random parameters and streams, and must
// agree bit for bit (Object.is on every output value).
import { describe, expect, it } from 'vitest';
import { compileLibrary } from '../src/compile.js';
import { parseProgram } from '../src/parser.js';
import { kernelContexts } from '../src/elaborate.js';
import { interpretKernel } from '../src/semantics/concrete.js';
import { agree } from './agree.js';
import { fixture, gezira, roda, strokeOracle, strokeSources } from './sources.js';

const library = ['types', 'bezier', 'stroke', 'rasterize', 'texture', 'compositor', 'gradient', 'filter'].map((n) => gezira(`${n}.nl`));
const PROGRAMS: [string, string[]][] = [
  ['gezira + paint scenes', [...library, fixture('paint-scenes.nl')]],
  ['RasterizeParallel', [gezira('types.nl'), gezira('bezier.nl'), gezira('rasterize.nl'), gezira('texture.nl'), roda('rasterize-parallel.nl')]],
  ['RasterizeExact', [gezira('types.nl'), gezira('bezier.nl'), gezira('rasterize.nl'), gezira('texture.nl'), roda('rasterize-parallel.nl'), roda('rasterize-exact.nl')]],
  ['chari kernels', [fixture('chari-kernels.nl')]],
];

describe.each(PROGRAMS)('interpreter ≡ compiler, kernel by kernel: %s', (_, sources) => agree(sources));

// Mid-stream ⇒, interpreted literally (the process becomes the pipeline, as
// in the 2012 C runtime) vs the compiler's defunctionalization
// (substitute.ts) vs the 2012 runtime itself (fixtures/stroke-oracle.json).
import { dupCat, pipeline, reverse, run } from '../src/cpu/runtime.js';

describe('mid-stream ⇒: interpreter ≡ compiler ≡ the 2012 runtime', () => {
  const sources = strokeSources();
  const compiled = compileLibrary(sources);
  const { program, kernels } = kernelContexts(parseProgram(sources).modules, true);
  const interp = (name: string, params: number[] = []) => {
    const c = kernels.get(name)!;
    return interpretKernel(program, c, params, (n) => kernels.get(n));
  };
  const build: Record<string, (p: number[]) => ReturnType<typeof interp>> = {
    OffsetBezier: (p) => interp('OffsetBezier', p),
    StrokeOneSide: (p) => interp('StrokeOneSide', p),
    StrokeBezierPath: (p) => pipeline([
      interp('SanitizeBezierPath'),
      dupCat(interp('StrokeOneSide', p), pipeline([reverse(), interp('ReverseBeziers'), interp('StrokeOneSide', p)])),
    ]),
  };
  const cases = strokeOracle();
  for (const process of Object.keys(build)) {
    it(process, () => {
      for (const c of cases.filter((x) => x.process === process)) {
        const got = run(build[process](c.params ?? []), c.input.map((t) => [...t]));
        const want = run(compiled.api[process](c.params), c.input.map((t) => [...t]));
        expect(got.length).toBe(c.output.length);
        got.forEach((t, i) => t.forEach((x, j) => {
          expect(Math.abs(x - c.output[i][j])).toBeLessThan(1e-6); // the 2012 runtime
          expect(Object.is(x, want[i][j])).toBe(true); // the compiler, bit for bit
        }));
      }
    });
  }
});

// The same ⇒, said in Mooi (streams.mooi: a process over a whole stream),
// against the interpreter above, bit for bit, and the 2012 runtime.
import { interpretProcess } from '../src/semantics/streams.js';

describe('mid-stream ⇒ as streams.mooi says it ≡ the interpreter ≡ the 2012 runtime', () => {
  const sources = strokeSources();
  const { program, kernels } = kernelContexts(parseProgram(sources).modules, true);
  const interp = (name: string, params: number[] = []) => interpretKernel(program, kernels.get(name)!, params, (n) => kernels.get(n));
  const proc = interpretProcess(program, (n) => kernels.get(n));
  // StrokeBezierPath's DupCat and Reverse are pipeline structure, not ⇒.
  const strokePath = (p: number[], xs: number[][]) => {
    const s = proc('SanitizeBezierPath', [], xs);
    return [...proc('StrokeOneSide', p, s), ...proc('StrokeOneSide', p, proc('ReverseBeziers', [], [...s].reverse()))];
  };
  const build: Record<string, [(p: number[], xs: number[][]) => number[][], (p: number[]) => ReturnType<typeof interp>]> = {
    OffsetBezier: [(p, xs) => proc('OffsetBezier', p, xs), (p) => interp('OffsetBezier', p)],
    StrokeOneSide: [(p, xs) => proc('StrokeOneSide', p, xs), (p) => interp('StrokeOneSide', p)],
    StrokeBezierPath: [strokePath, (p) => pipeline([
      interp('SanitizeBezierPath'),
      dupCat(interp('StrokeOneSide', p), pipeline([reverse(), interp('ReverseBeziers'), interp('StrokeOneSide', p)])),
    ])],
  };
  for (const [process, [mooi, ts]] of Object.entries(build)) {
    it(process, () => {
      for (const c of strokeOracle().filter((x) => x.process === process)) {
        const got = mooi(c.params ?? [], c.input.map((t) => [...t]));
        const want = run(ts(c.params ?? []), c.input.map((t) => [...t]));
        expect(got.length).toBe(c.output.length);
        got.forEach((t, i) => t.forEach((x, j) => {
          expect(Math.abs(x - c.output[i][j])).toBeLessThan(1e-6);
          expect(Object.is(x, want[i][j])).toBe(true);
        }));
      }
    });
  }
});

// Where there is no recording: a prologue that feeds back (RectangleSpans),
// a step that feeds back before a ⇒ downstream (DashBeziers into roda's
// pieces), against the interpreter bit for bit.
describe('streams.mooi ≡ the interpreter, beyond the recordings', () => {
  const sources = [...['types', 'bezier', 'stroke', 'rasterize'].map((n) => gezira(`${n}.nl`)), ...['vector', 'dash'].map((n) => roda(`${n}.nl`))];
  const { program, kernels } = kernelContexts(parseProgram(sources).modules, true);
  const interp = (name: string, params: number[]) => interpretKernel(program, kernels.get(name)!, params, (n) => kernels.get(n));
  const proc = interpretProcess(program, (n) => kernels.get(n));
  const line = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, (x0 + x1) / 2, (y0 + y1) / 2, x1, y1];
  const cases: [string, number[], number[][][]][] = [
    ['RectangleSpans', [0, 0, 2, 2], [[], [[1.25, 0]], [[0.5, 0.5], [3, 3], [1.5, 1]]]],
    ['RectangleSpans', [-1, 0.5, 1.5, 3], [[], [[0, 1], [-0.5, 2]]]],
    ['DashBeziers', [20, 10, 5, 5, 3], [[line(0, 0, 60, 0), line(60, 0, 100, 40)]]],
    ['StrokePiecesOneSide', [4, -1, -1], [[line(0, 0, 10, 0), line(10, 0, 10, 10)], [line(0, 0, 10, 0), line(20, 0, 30, 5), line(30, 5, 0, 0)]]],
    ['StrokePiecesOneSide', [2, 4, 0], [[line(0, 0, 10, 0), line(20, 0, 30, 5)]]],
  ];
  for (const [process, params, inputs] of cases) {
    it(`${process} (${params})`, () => {
      for (const input of inputs) {
        const got = proc(process, params, input.map((t) => [...t]));
        const want = run(interp(process, params), input.map((t) => [...t]));
        expect(got.length).toBe(want.length);
        got.forEach((t, i) => t.forEach((x, j) => expect(Object.is(x, want[i][j])).toBe(true)));
      }
    });
  }
});
