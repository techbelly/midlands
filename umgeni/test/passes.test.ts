import { describe, expect, it } from 'vitest';
import { gezira } from './sources.js';
import { compileProgram, makeStreamer } from '../src/compile.js';
import { opCount } from '../src/passes/cse.js';
import type { ScalarExpr, Stmt } from '../src/ir.js';
import { run } from '../src/cpu/runtime.js';

function staticOps(program: ReturnType<typeof compileProgram>, name: string): number {
  const k = program.ir.processes.find((p) => p.name === name);
  if (!k || k.k !== 'kernel') throw new Error(`no kernel ${name}`);
  const stmts = (ss: Stmt[]): number => ss.reduce((n, s) => {
    switch (s.k) {
      case 'let': case 'assign': case 'setState': return n + opCount(s.expr);
      case 'emit': case 'feed': return n + s.values.reduce((m, v) => m + opCount(v), 0);
      case 'if': return n + opCount(s.cond) + stmts(s.then) + stmts(s.else);
    }
  }, 0);
  return stmts(k.init) + stmts(k.body) + stmts(k.epilogue)
    + k.stateInit.reduce((n: number, e: ScalarExpr) => n + opCount(e), 0);
}


describe('CSE pass', () => {
  it('shares duplicated subtrees introduced by operator inlining', () => {
    // ◁'s body `{ a if a < b, b }` uses `a` twice; without CSE the |x| tree
    // is duplicated inside it.
    const src = [
      '| (a : Real) | : Real',
      '    { -a if a < 0, a }',
      '(a : Real) ◁ (b : Real) : Real',
      '    { a if a < b, b }',
      'K : Real >> Real',
      '    ∀ x',
      '        >> | x - 10 | ◁ 3',
    ].join('\n');
    const plain = compileProgram([src], { cse: false });
    const cse = compileProgram([src], { cse: true });
    expect(cse.source).toContain('__cse'); // a shared let was introduced
    expect(staticOps(cse, 'K')).toBeLessThan(staticOps(plain, 'K'));
    for (const v of [0, 8, 9.5, 12, 20]) {
      expect(run(cse.registry.get('K')!(), [[v]])).toEqual(run(plain.registry.get('K')!(), [[v]]));
    }
  });

  it('does not merge values across a mutation of a primed local (epochs)', () => {
    const src = [
      'K : Real >> Real',
      '    s = 0',
      '    ∀ a',
      "        s' = a",
      "        x = (s' + 1) × (s' + 1)",
      "        s' = s' + 1",
      "        y = (s' + 1) × (s' + 1)",
      '        >> x + y',
    ].join('\n');
    const s = makeStreamer(compileProgram([src], { cse: true }), 'K');
    // s'=2: x=9; s'=3: y=16. A stale merge would give 9+9=18.
    expect(s.push([2])).toEqual([[25]]);
  });

  it('preserves rasterizer output exactly (with boolCond too)', () => {
    const sources = [gezira('types.nl'), gezira('rasterize.nl')];
    const plain = compileProgram(sources, { cse: false, boolCond: false });
    const opt = compileProgram(sources, { cse: true, boolCond: true });
    const tokens = Array.from({ length: 10 }, (_, i) => [
      (i * 37) % 11, (i * 53) % 7, (i * 29) % 13, (i * 41) % 5, (i * 61) % 9, (i * 17) % 8,
    ]);
    expect(run(opt.registry.get('Rasterize')!(), tokens))
      .toEqual(run(plain.registry.get('Rasterize')!(), tokens));
  });
});
