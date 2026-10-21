// Regenerate test/fixtures/chari-oracle.json: chari (the earlier,
// tiger-validated closure compiler for Nile) run on test/fixtures/
// chari-kernels.nl. Needs a chari checkout (default: a sibling of midlands).
//   CHARI=/path/to/chari npx tsx umgeni/tools/oracle/gen-chari-fixtures.ts
//
// chari nests records (a Bezier is [[x,y],[x,y],[x,y]]); umgeni flattens
// (6 numbers). Cases are recorded flat. -0 is kept (as "-0"): the check is bitwise.
import { readFileSync, writeFileSync } from 'node:fs';

type ChariToken = number | ChariToken[];
const chari = process.env.CHARI ?? new URL('../../../../chari/', import.meta.url).pathname;
const { compileModule } = await import(`${chari}/src/compiler/index.ts`);
const { run } = await import(`${chari}/src/runtime/index.ts`);

const fixtures = new URL('../../test/fixtures/', import.meta.url);
const registry = compileModule(readFileSync(new URL('chari-kernels.nl', fixtures), 'utf8'));

// A nesting is the number of leaves per top-level field.
type Nesting = number[];
function nest(flat: number[], nesting: Nesting): ChariToken {
  if (nesting.every((n) => n === 1)) return flat;
  let at = 0;
  return nesting.map((n) => {
    const part = flat.slice(at, at + n);
    at += n;
    return n === 1 ? part[0] : part;
  });
}
const flatten = (t: ChariToken): number[] => (typeof t === 'number' ? [t] : t.flatMap(flatten));
const POINT = [1, 1], BEZIER = [2, 2, 2], CUBIC = [2, 2, 2, 2], FLAT4 = [1, 1, 1, 1];

// Deterministic pseudo-random inputs (LCG).
function randomTokens(count: number, width: number, scale: number, seed: number): number[][] {
  let s = seed >>> 0;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  return Array.from({ length: count }, () => Array.from({ length: width }, () => Math.round(rand() * scale * 100) / 100));
}

// A small closed path (a triangle) as cubics, for the end-to-end pipelines.
function trianglePath(): number[][] {
  const pts: [number, number][] = [[1, 1], [7, 2], [4, 6]];
  return pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    return [...a, a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3, a[0] + (2 * (b[0] - a[0])) / 3, a[1] + (2 * (b[1] - a[1])) / 3, ...b];
  });
}

const M = [1.25, 0.1, -0.15, 1.1, 0.5, 0.25]; // a mild affine map
const samples = randomTokens(30, 4, 6, 4)
  .map((t) => [Math.floor(t[0]) + 0.5, Math.floor(t[1]) + 0.5, t[2] / 6 - 0.5, t[3] / 6 - 0.5])
  .sort((a, b) => (a[1] !== b[1] ? a[1] - b[1] : a[0] - b[0]));

const CASES: { what: string; process: string; args?: ChariToken[]; nesting: Nesting; input: number[][] }[] = [
  { what: 'pointwise math and operator inlining', process: 'TransformCubics', args: [M], nesting: CUBIC, input: randomTokens(20, 8, 10, 1) },
  { what: 'recursive subdivision via feedback', process: 'FlattenCubics', nesting: CUBIC, input: randomTokens(10, 8, 8, 2) },
  { what: 'feedback with guards, floors, and midpoint snapping', process: 'DecomposeBeziers', nesting: BEZIER, input: randomTokens(10, 6, 8, 3) },
  { what: 'primed state and an epilogue emit', process: 'CombineEdgeSamples', nesting: FLAT4, input: samples },
  { what: 'record-valued guards choosing per component', process: 'ClipBeziers', args: [nest([1, 1], POINT), nest([6, 6], POINT)], nesting: BEZIER, input: randomTokens(12, 6, 8, 5) },
  { what: 'nested conditionals and perpendicular math', process: 'StrokeBezier', args: [1.5], nesting: BEZIER, input: randomTokens(10, 6, 8, 6) },
  { what: 'caps and joins driven by carried state', process: 'StrokeStyled', args: [2, 1, 1], nesting: BEZIER, input: randomTokens(8, 6, 8, 7) },
  { what: 'the full fill pipeline (transform → flatten → clip → rasterize)', process: 'FillTiger', args: [M, nest([0, 0], POINT), nest([16, 16], POINT)], nesting: CUBIC, input: trianglePath() },
  { what: 'the full stroke pipeline', process: 'StrokeTiger', args: [M, 1.25, nest([0, 0], POINT), nest([16, 16], POINT)], nesting: CUBIC, input: trianglePath() },
];

const cases = CASES.map((c) => {
  const output = run(registry.get(c.process)!(c.args ?? []), c.input.map((t) => nest(t, c.nesting))).map(flatten);
  if (output.length === 0) throw new Error(`${c.process}: no output`);
  return { what: c.what, process: c.process, params: (c.args ?? []).flatMap(flatten), input: c.input, output };
});
const out = new URL('chari-oracle.json', fixtures);
writeFileSync(out, JSON.stringify({ source: 'chari on chari-kernels.nl', cases }, (_, v) => (Object.is(v, -0) ? '-0' : v)) + '\n');
console.log(`${cases.length} cases -> ${out.pathname}`);
