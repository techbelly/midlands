// Conformance, generated from the operator table (src/scalar.ts): each
// operator's evaluator is its specification, and the JS and wasm backends
// must agree with it exactly — including on NaN, ±0 and ±∞.
import { describe, expect, it } from 'vitest';
import { compileProgram, makeStreamer } from '../src/compile.js';
import { BIN, UN } from '../src/scalar.js';

const VALUES = [0, -0, 1, -1, 0.5, -2.5, 3, Infinity, -Infinity, NaN, 1e-300, 7.75];
// Nile spelling of an application: infix, prefix ('-_'), or outfix ('⌊_⌋').
const apply = (glyph: string, a: string, b?: string) =>
  b !== undefined ? `${a} ${glyph} ${b}` : glyph.replace('_', ` ${a} `);

describe('scalar operators: every backend agrees with the table', () => {
  const kernels = [
    ...Object.entries(BIN).map(([n, op]) => `B${n} : (Real, Real) >> Real\n    ∀ (a, b)\n        >> ${apply(op.nile, 'a', 'b')}\n`),
    ...Object.entries(UN).map(([n, op]) => `U${n} : Real >> Real\n    ∀ a\n        >> ${apply(op.nile, 'a')}\n`),
  ];
  // A trivial pipeline around each kernel so it fuses (and so compiles to wasm).
  const pipes = [...Object.keys(BIN).map((n) => `B${n}`), ...Object.keys(UN).map((n) => `U${n}`)]
    .map((k) => `P${k} : ${k.startsWith('B') ? '(Real, Real)' : 'Real'} >> Real\n    ⇒ ${k} → (→)\n`);
  const programs = [{}, { target: 'wasm' as const }, { boolCond: false, cse: false }]
    .map((o) => compileProgram([...kernels, ...pipes], o));
  it('exercises the wasm backend', () => expect(programs[1].source).toContain('rt.wasmSegment('));

  for (const [name, op] of Object.entries(BIN)) {
    it(`${op.nile} (${name})`, () => {
      for (const p of programs) {
        expect(p.unsupported).toEqual([]);
        const s = makeStreamer(p, `PB${name}`);
        for (const a of VALUES) for (const b of VALUES) expect(Object.is(s.push([a, b])[0][0], op.f(a, b))).toBe(true);
      }
    });
  }
  for (const [name, op] of Object.entries(UN)) {
    it(`${op.nile} (${name})`, () => {
      for (const p of programs) {
        const s = makeStreamer(p, `PU${name}`);
        for (const a of VALUES) expect(Object.is(s.push([a])[0][0], op.f(a))).toBe(true);
      }
    });
  }
});
